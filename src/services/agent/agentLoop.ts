/**
 * Agent Loop - Agent核心循环实现
 * 参考OpenAI Agents SDK设计
 * 
 * 核心循环：
 * 1. 调用LLM获取响应
 * 2. 如果响应有final output（无tool_calls），返回结果，结束循环
 * 3. 如果有tool_calls，执行工具调用
 * 4. 将工具结果返回给LLM
 * 5. 回到步骤1
 */

import { AgentLogger, LogLevel, LogStage } from './agentLogger'
import type {
  AgentConfig,
  AgentMessage,
  AgentResult,
  AgentStateType,
  AgentCallbacks,
  LLMResponse,
  OpenAIToolCall,
  OpenAIToolDefinition,
  ReActStep,
  ReActContext,
  ToolExecutionResult
} from './agentTypes'

export class AgentLoop {
  private config: AgentConfig
  private tools: Map<string, OpenAIToolDefinition>
  private toolFunctions: Map<string, Function>
  private messages: AgentMessage[]
  private state: AgentStateType
  private logger: AgentLogger
  private callbacks: AgentCallbacks
  private sessionId: string
  private currentToolName: string = ''

  constructor(
    config: AgentConfig,
    logger: AgentLogger,
    callbacks: AgentCallbacks = {}
  ) {
    this.config = {
      temperature: 0.7,
      maxTokens: 4096,
      maxIterations: 50,
      ...config
    }
    this.tools = new Map()
    this.toolFunctions = new Map()
    this.messages = []
    this.state = 'IDLE'
    this.logger = logger
    this.callbacks = callbacks
    this.sessionId = logger['sessionId']
  }

  /**
   * 报告工具执行进度
   * 供工具内部调用
   */
  reportProgress(current: number, total: number, message?: string): void {
    if (this.currentToolName) {
      this.callbacks.onToolProgress?.(this.currentToolName, current, total, message)
    }
  }

  /**
   * 注册工具
   */
  registerTool(name: string, definition: OpenAIToolDefinition, fn: Function): void {
    this.tools.set(name, definition)
    this.toolFunctions.set(name, fn)
    this.logger.debug(LogStage.TOOL_CALL_START, {
      action: 'register',
      toolName: name,
      description: definition.function.description
    })
  }

  /**
   * 设置系统提示
   */
  setSystemPrompt(prompt: string): void {
    // 检查是否已有system消息
    const existingSystemIndex = this.messages.findIndex(m => m.role === 'system')
    if (existingSystemIndex >= 0) {
      this.messages[existingSystemIndex].content = prompt
    } else {
      this.messages.unshift({
        role: 'system',
        content: prompt
      })
    }

    this.logger.debug(LogStage.SYSTEM_PROMPT, {
      promptLength: prompt.length,
      prompt: prompt.slice(0, 500) + (prompt.length > 500 ? '...' : '')
    })
  }

  /**
   * 加载历史消息（用于多轮对话上下文）
   */
  loadHistory(history: AgentMessage[]): void {
    // 过滤掉system消息，因为setSystemPrompt会单独设置
    const nonSystemMessages = history.filter(m => m.role !== 'system')
    this.messages.push(...nonSystemMessages)

    this.logger.debug(LogStage.MESSAGE_HISTORY, {
      action: 'loadHistory',
      loadedCount: nonSystemMessages.length,
      totalCount: this.messages.length
    })
  }

  /**
   * 运行Agent Loop
   */
  async run(userInput: string, signal?: AbortSignal): Promise<AgentResult> {
    const startTime = Date.now()
    const steps: ReActStep[] = []

    // 记录会话开始
    this.logger.info(LogStage.SESSION_START, {
      userInput,
      inputLength: userInput.length,
      startTime: new Date(startTime).toISOString()
    })

    // 添加用户消息
    this.messages.push({
      role: 'user',
      content: userInput
    })

    // 记录消息历史
    this.logger.debug(LogStage.MESSAGE_HISTORY, {
      messageCount: this.messages.length,
      messages: this.messages.map(m => ({
        role: m.role,
        contentLength: m.content?.length || 0
      }))
    })

    // Agent Loop
    for (let iteration = 0; iteration < this.config.maxIterations!; iteration++) {
      // 检查是否已取消
      if (signal?.aborted) {
        this.logger.info(LogStage.SESSION_END, {
          reason: 'cancelled_by_user',
          iteration: iteration + 1
        })
        throw new Error('AbortError')
      }

      this.logger.info(LogStage.ITERATION_START, {
        iteration: iteration + 1,
        maxIterations: this.config.maxIterations
      })

      // 状态转换：THINKING
      this.transitionState('THINKING', { iteration: iteration + 1 })

      // 调用LLM
      const llmResponse = await this.callLLM(signal)

      // 解析响应
      const parsedResponse = this.parseLLMResponse(llmResponse)

      // 记录思考过程
      if (parsedResponse.thought) {
        this.logger.debug(LogStage.JSON_FIELD_EXTRACT, {
          field: 'thought',
          content: parsedResponse.thought
        })
        this.callbacks.onThinking?.(parsedResponse.thought)
      }

      // 创建步骤记录
      const step: ReActStep = {
        iteration: iteration + 1,
        thought: parsedResponse.thought
      }

      // 检查是否有工具调用
      if (!parsedResponse.tool_calls || parsedResponse.tool_calls.length === 0) {
        // 没有工具调用，直接返回content
        const finalContent = parsedResponse.content || '抱歉，AI没有生成回复'
        
        step.finalAnswer = finalContent
        steps.push(step)

        this.logger.info(LogStage.FINAL_OUTPUT, {
          output: finalContent,
          outputLength: finalContent.length,
          iterations: iteration + 1,
          totalDuration: Date.now() - startTime
        })

        this.callbacks.onReply?.(finalContent)
        this.transitionState('FINISHED', { reason: 'no_tool_calls' })
        this.logger.endSession()

        return {
          content: finalContent,
          steps,
          toolCalls: this.getToolCallHistory(steps),
          duration: Date.now() - startTime,
          iterations: iteration + 1
        }
      }

      // 有工具调用
      step.action = parsedResponse.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.safeParseJSON(tc.function.arguments, {})
      }))

      this.logger.info(LogStage.TOOL_CALL_START, {
        toolCount: parsedResponse.tool_calls.length,
        tools: parsedResponse.tool_calls.map(tc => tc.function.name)
      })

      // 状态转换：TOOL_CALLING
      this.transitionState('TOOL_CALLING', { toolCount: parsedResponse.tool_calls.length })

      // 添加assistant消息（包含tool_calls）
      this.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: parsedResponse.tool_calls
      })

      // 执行工具调用
      const toolResults: ToolExecutionResult[] = []
      for (const toolCall of parsedResponse.tool_calls) {
        // 检查是否已取消
        if (signal?.aborted) {
          this.logger.info(LogStage.SESSION_END, {
            reason: 'cancelled_during_tool_execution',
            tool: toolCall.function.name
          })
          throw new Error('AbortError')
        }

        const result = await this.executeTool(toolCall, signal)
        toolResults.push(result)

        // 添加tool结果消息
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: result.success ? JSON.stringify(result.data) : (result.error || '执行失败')
        })
      }

      // 记录观察结果
      step.observation = toolResults.map(tr => 
        tr.success 
          ? `[${tr.toolName}] 成功` 
          : `[${tr.toolName}] 失败: ${tr.error}`
      ).join('\n')

      steps.push(step)

      this.logger.info(LogStage.ITERATION_END, {
        iteration: iteration + 1,
        toolResults: toolResults.map(tr => ({
          toolName: tr.toolName,
          success: tr.success,
          duration: tr.duration
        }))
      })
    }

    // 超过最大迭代次数
    this.logger.warn(LogStage.ITERATION_END, {
      reason: 'max_iterations_reached',
      maxIterations: this.config.maxIterations
    })

    // 构建已完成的工具调用摘要
    const completedTools = steps
      .filter(s => s.action && s.action.length > 0)
      .flatMap(s => s.action || [])
      .map(a => a.name)
      .filter((name, index, arr) => arr.indexOf(name) === index)

    let fallbackMessage = '我已经尝试了多种方法来回答您的问题，但可能需要更多步骤来完成。'

    if (completedTools.length > 0) {
      fallbackMessage += `\n\n目前已完成的分析：${completedTools.join('、')}`
    }

    fallbackMessage += '\n\n您可以：'
    fallbackMessage += '\n1. 将问题拆分成更具体的子问题'
    fallbackMessage += '\n2. 指定具体的联系人或时间范围'
    fallbackMessage += '\n3. 或者告诉我您最关心哪个方面，我优先分析'

    this.logger.info(LogStage.FINAL_OUTPUT, {
      output: fallbackMessage,
      reason: 'max_iterations',
      completedTools,
      totalDuration: Date.now() - startTime
    })

    this.transitionState('FINISHED', { reason: 'max_iterations' })
    this.logger.endSession()

    return {
      content: fallbackMessage,
      steps,
      toolCalls: this.getToolCallHistory(steps),
      duration: Date.now() - startTime,
      iterations: this.config.maxIterations!
    }
  }

  /**
   * 调用LLM
   */
  private async callLLM(signal?: AbortSignal): Promise<string> {
    // 检查是否已取消
    if (signal?.aborted) {
      this.logger.info(LogStage.LLM_RESPONSE_END, {
        reason: 'cancelled_before_request'
      })
      throw new Error('AbortError')
    }

    this.transitionState('THINKING', { action: 'calling_llm' })

    const toolsArray = Array.from(this.tools.values())

    this.logger.debug(LogStage.LLM_REQUEST, {
      model: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      messageCount: this.messages.length,
      toolCount: toolsArray.length
    })

    this.logger.info(LogStage.LLM_RESPONSE_START, {
      timestamp: new Date().toISOString()
    })

    try {
      const response = await fetch(`${this.config.apiUrl}/v1/chat/completions`, {
        signal, // 传递 AbortSignal 以支持取消
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: this.messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          tools: toolsArray.length > 0 ? toolsArray : undefined,
          tool_choice: toolsArray.length > 0 ? 'auto' : undefined
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API请求失败: ${response.status} - ${errorText}`)
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message

      this.logger.info(LogStage.LLM_RESPONSE_END, {
        timestamp: new Date().toISOString(),
        hasContent: !!content?.content,
        hasToolCalls: !!content?.tool_calls
      })

      // 返回完整的message对象作为JSON字符串
      return JSON.stringify(content)

    } catch (error: any) {
      const errorMessage = error?.message || '未知错误'
      const errorDetails: any = {
        error: errorMessage,
        errorType: error?.name || 'UnknownError',
        apiUrl: this.config.apiUrl,
        model: this.config.model,
        hasApiKey: !!this.config.apiKey
      }
      
      // 针对常见错误提供更详细的说明
      if (errorMessage.includes('Failed to fetch')) {
        errorDetails.suggestion = '请检查：1. API地址是否正确 2. 网络连接是否正常 3. API密钥是否配置'
      } else if (errorMessage.includes('401')) {
        errorDetails.suggestion = 'API密钥无效或已过期，请检查设置中的API密钥'
      } else if (errorMessage.includes('404')) {
        errorDetails.suggestion = 'API地址错误，请检查设置中的API地址'
      } else if (errorMessage.includes('429')) {
        errorDetails.suggestion = '请求过于频繁，请稍后再试'
      }
      
      if (error?.stack) {
        errorDetails.stack = error.stack
      }
      
      this.logger.error(LogStage.LLM_RESPONSE_END, errorDetails)
      
      // 抛出带有详细信息的错误
      const enhancedError = new Error(
        `API请求失败: ${errorMessage}${errorDetails.suggestion ? ` (${errorDetails.suggestion})` : ''}`
      )
      throw enhancedError
    }
  }

  /**
   * 解析LLM响应
   */
  private parseLLMResponse(rawResponse: string): LLMResponse {
    this.logger.debug(LogStage.JSON_PARSE_START, {
      rawLength: rawResponse.length
    })

    try {
      const parsed = JSON.parse(rawResponse)

      // 提取thought（如果content中包含）
      let thought: string | undefined
      let content = parsed.content

      if (content && typeof content === 'string') {
        // 尝试从content中提取thought
        const thoughtMatch = content.match(/<think>([\s\S]*?)<\/think>/)
        if (thoughtMatch) {
          thought = thoughtMatch[1].trim()
          content = content.replace(/<think>[\s\S]*?<\/think>/, '').trim()
        }
      }

      const result: LLMResponse = {
        content: content,
        tool_calls: parsed.tool_calls,
        thought
      }

      this.logger.debug(LogStage.JSON_PARSE_SUCCESS, {
        hasContent: !!result.content,
        hasToolCalls: !!result.tool_calls,
        toolCallCount: result.tool_calls?.length || 0,
        hasThought: !!result.thought
      })

      return result

    } catch (error: any) {
      this.logger.error(LogStage.JSON_PARSE_ERROR, {
        rawResponse: rawResponse.slice(0, 500),
        error: error?.message
      })

      // 返回降级结果
      return {
        content: rawResponse,
        tool_calls: undefined
      }
    }
  }

  /**
   * 执行工具
   */
  private async executeTool(toolCall: OpenAIToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const toolName = toolCall.function.name
    const toolCallId = toolCall.id
    const startTime = Date.now()

    // 设置当前工具名，用于进度报告
    this.currentToolName = toolName

    // 检查是否已取消
    if (signal?.aborted) {
      this.logger.info(LogStage.TOOL_EXEC_ERROR, {
        toolName,
        toolCallId,
        reason: 'cancelled_before_execution'
      })
      this.currentToolName = ''
      throw new Error('AbortError')
    }

    this.logger.info(LogStage.TOOL_EXEC_START, {
      toolName,
      toolCallId,
      startTime: new Date(startTime).toISOString()
    })

    // 解析参数
    let args: Record<string, any>
    try {
      args = JSON.parse(toolCall.function.arguments)
    } catch {
      args = {}
    }

    this.logger.debug(LogStage.TOOL_CALL_PARAMS, {
      toolName,
      arguments: args
    })

    this.callbacks.onToolCall?.(toolName, args)

    // 获取工具函数
    const toolFn = this.toolFunctions.get(toolName)
    if (!toolFn) {
      const error = `未知工具: ${toolName}`
      this.logger.error(LogStage.TOOL_EXEC_ERROR, {
        toolName,
        toolCallId,
        errorType: 'ToolNotFound',
        errorMessage: error
      })

      this.currentToolName = ''
      return {
        success: false,
        error,
        errorType: 'ToolNotFound',
        duration: Date.now() - startTime,
        toolName,
        toolCallId
      }
    }

    try {
      // 执行工具（传递 signal 和 progress 回调以支持取消和进度报告）
      const result = await toolFn(args, signal, (current: number, total: number, message?: string) => {
        this.reportProgress(current, total, message)
      })
      const duration = Date.now() - startTime

      this.logger.info(LogStage.TOOL_EXEC_SUCCESS, {
        toolName,
        toolCallId,
        duration,
        resultType: typeof result,
        resultSize: JSON.stringify(result).length
      })

      const toolResult: ToolExecutionResult = {
        success: true,
        data: result,
        duration,
        toolName,
        toolCallId
      }

      this.callbacks.onToolResult?.(toolName, toolResult)

      this.currentToolName = ''
      return toolResult

    } catch (error: any) {
      const duration = Date.now() - startTime
      const errorMessage = error?.message || error?.toString() || '未知错误'

      this.logger.error(LogStage.TOOL_EXEC_ERROR, {
        toolName,
        toolCallId,
        duration,
        errorType: error?.name || 'UnknownError',
        errorMessage,
        errorStack: error?.stack
      })

      const toolResult: ToolExecutionResult = {
        success: false,
        error: errorMessage,
        errorType: error?.name || 'UnknownError',
        duration,
        toolName,
        toolCallId
      }

      this.callbacks.onToolResult?.(toolName, toolResult)

      this.currentToolName = ''
      return toolResult
    }
  }

  /**
   * 状态转换
   */
  private transitionState(newState: AgentStateType, metadata?: any): void {
    const oldState = this.state
    this.state = newState

    this.logger.debug(LogStage.STATE_TRANSITION, {
      from: oldState,
      to: newState,
      metadata
    })

    this.callbacks.onStateChange?.(oldState, newState)
  }

  /**
   * 获取工具调用历史
   */
  private getToolCallHistory(steps: ReActStep[]): string[] {
    const toolCalls: string[] = []
    for (const step of steps) {
      if (step.action) {
        for (const action of step.action) {
          toolCalls.push(action.name)
        }
      }
    }
    return toolCalls
  }

  /**
   * 安全解析JSON
   */
  private safeParseJSON(json: string, defaultValue: any): any {
    try {
      return JSON.parse(json)
    } catch {
      return defaultValue
    }
  }

  /**
   * 获取当前状态
   */
  getState(): AgentStateType {
    return this.state
  }

  /**
   * 获取消息历史
   */
  getMessages(): AgentMessage[] {
    return [...this.messages]
  }
}

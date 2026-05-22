/**
 * Agent Types - Agent引擎类型定义
 * 参考OpenAI Agents SDK和Function Calling标准
 */

// ============================================================================
// OpenAI标准格式类型
// ============================================================================

/**
 * OpenAI工具调用格式（标准）
 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON字符串
  }
}

/**
 * OpenAI函数定义（标准）
 */
export interface OpenAIFunctionDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

/**
 * OpenAI工具定义（标准）
 */
export interface OpenAIToolDefinition {
  type: 'function'
  function: OpenAIFunctionDefinition
}

/**
 * LLM响应（OpenAI标准格式）
 */
export interface LLMResponse {
  content: string | null
  tool_calls?: OpenAIToolCall[]
  // 扩展字段（用于显示）
  thought?: string
}

// ============================================================================
// Agent状态类型
// ============================================================================

export type AgentStateType = 
  | 'IDLE' 
  | 'THINKING' 
  | 'TOOL_CALLING' 
  | 'OBSERVATION' 
  | 'FINISHED' 
  | 'ERROR'

export interface AgentStateTransition {
  from: AgentStateType
  to: AgentStateType
  reason?: string
  timestamp: number
}

// ============================================================================
// 工具相关类型
// ============================================================================

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  success: boolean
  data?: any
  error?: string
  errorType?: string
  duration: number
  toolName: string
  toolCallId: string
}

/**
 * 工具定义
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

/**
 * 工具函数类型
 */
export type ToolFunction = (args: Record<string, any>) => Promise<any>

// ============================================================================
// Agent配置类型
// ============================================================================

export interface AgentConfig {
  model: string
  apiUrl: string
  apiKey: string
  temperature?: number
  maxTokens?: number
  maxIterations?: number
}

// ============================================================================
// Agent消息类型
// ============================================================================

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

// ============================================================================
// ReAct步骤类型
// ============================================================================

export interface ReActStep {
  iteration: number
  thought?: string
  action?: Array<{
    id: string
    name: string
    arguments: Record<string, any>
  }>
  observation?: string
  finalAnswer?: string
}

export interface ReActContext {
  currentIteration: number
  maxIterations: number
  isComplete: boolean
}

// ============================================================================
// 流式输出回调类型
// ============================================================================

export interface AgentCallbacks {
  onThinking?: (thought: string) => void
  onToolCall?: (toolName: string, args: Record<string, any>) => void
  onToolResult?: (toolName: string, result: ToolExecutionResult) => void
  onToolProgress?: (toolName: string, current: number, total: number, message?: string) => void
  onReply?: (reply: string) => void
  onStream?: (chunk: string) => void
  onStateChange?: (oldState: AgentStateType, newState: AgentStateType) => void
  onError?: (error: Error) => void
}

// ============================================================================
// Agent结果类型
// ============================================================================

export interface AgentResult {
  content: string
  steps: ReActStep[]
  toolCalls: string[]
  duration: number
  iterations: number
}

// ============================================================================
// 日志相关类型（从agentLogger导入）
// ============================================================================

export type { LogEntry, AgentLoggerOptions } from './agentLogger'
export { LogLevel, LogStage } from './agentLogger'

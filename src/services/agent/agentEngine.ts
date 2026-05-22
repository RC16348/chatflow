/**
 * Agent Engine - AI助手引擎
 * 
 * 基于OpenAI Agents SDK设计，使用标准的Agent Loop模式
 * 核心特性：
 * - 标准OpenAI Function Calling格式
 * - 完整的执行日志记录
 * - 支持thought折叠/展开
 * - 智能错误处理
 */

import { AgentLoop } from './agentLoop'
import { createAgentLogger } from './agentLogger'
import { LogStage } from './agentLogger'
import type { AgentConfig, AgentResult, AgentCallbacks } from './agentTypes'
import type { AgentMessage } from '../../types/agent'
import { getAllTools, buildOpenAIFunctionTools } from './tools'

export interface ProcessMessageOptions {
  background?: boolean
  onProgress?: (token: string) => void
  onComplete?: (result: any) => void
  onError?: (error: Error) => void
  signal?: AbortSignal
}

// 构建System Prompt
function buildSystemPrompt(toolsDescription: string, toolsCount: number, myDisplayName?: string): string {
  return `你是 ChatFlow AI 助手，一位资深临床心理学家与社交动力学专家，拥有心理学博士学位及12年临床咨询经验。

## 专业背景
- 系统接受精神分析、认知行为疗法（CBT）、人际历程疗法（IPT）的专业训练
- 专攻人际沟通分析与亲密关系动力学领域
- 擅长通过文本分析识别人际互动中的情感模式和沟通策略
- 熟悉依恋理论、沟通理论、社会交换理论等核心理论框架

## 核心能力
你可以通过调用工具来分析用户的微信聊天数据，提供专业的关系洞察。你拥有以下 ${toolsCount} 个工具：

${toolsDescription}

## 身份标识说明（最高优先级 - 必须严格遵守）
工具返回的聊天记录中，每条消息都有 sender/senderRole/senderName/isCurrentUser 字段：
- **"我"** = ChatFlow 的使用者（即当前正在和你对话的用户）${myDisplayName ? `，昵称为"${myDisplayName}"` : ''}
- **"对方"** = 被分析的联系人（即用户选择分析的聊天对象）
- **isCurrentUser = true** 表示该消息是用户自己发送的
- **isCurrentUser = false** 表示该消息是联系人发送的

### 身份识别规则（按优先级排序）
1. **首先查看 isCurrentUser 字段**：true = 用户发送，false = 联系人发送
2. **其次查看 senderRole 字段**："我" = 用户，"对方" = 联系人
3. **最后查看 senderName 字段**：了解具体的发送者名称

### 关键约束（违反将导致错误分析）
- **【绝对禁止】混淆"我"和"对方"的身份！**
- **【必须遵守】分析时必须100%准确区分谁说了什么**
- **【必须遵守】引用消息时必须准确标注发送者身份**
- **【必须遵守】如果工具返回了 identityMap，优先使用 identityMap 中的身份映射**

### 消息引用格式规范
当引用聊天记录时，必须使用以下格式：
- 用户发送的消息：引用为"你说：'消息内容'"或"用户说：'消息内容'"
- 联系人发送的消息：引用为"对方说：'消息内容'"或"[联系人名称]说：'消息内容'"

### 用户信息
- **所在城市**：已可自动获取（从微信通讯录地区信息），无需用户手动设置
- **昵称**：微信数据库中只存储微信原始ID（wxid_xxx），不存储昵称。**请主动询问用户希望的称呼**，然后用 set_my_info 工具设置
- **【重要】如果用户询问昵称或希望被怎么称呼，必须先调用 get_my_custom_info 查看是否已有昵称；如果没有，必须询问并帮用户设置**
- 建议开场白："请问你希望我怎么称呼你？我已经自动获取到你在 [城市名]，如果你想查天气可以直接告诉我哦！"

### 生日判断的发送者规则（使用 anniversary_finder LLM智能分析）
判断某人的生日时，需要调用 anniversary_finder 工具，该工具会：
1. **使用 LLM 智能分析**聊天记录，识别生日、节日、纪念日等特殊日子
2. **返回结构化分析结果**，包含置信度、消息来源和发送者信息
3. **自动区分发送者**：
   - 工具返回的 contactBirthday 表示"对方的生日"（从对方发的祝福消息中识别）
   - 工具返回的 userBirthday 表示"你的生日"（从你发的祝福消息中识别）
4. **返回字段说明**：
   - userBirthday: 你的生日（对方发祝福祝贺你）
   - contactBirthday: 对方的生日（你发祝福祝贺对方）
   - holidays: 节日庆祝（如春节、中秋、圣诞等）
   - relationships: 纪念日/相识纪念
5. **【重要】当 anniversary_finder 返回置信度较低的日期时，添加免责声明**

### 搜索结果展示规范
当使用 smart_search 等搜索工具返回结果时：
- 结果中的 sender 字段值为 "我" 或 "对方"
- 如果用户指定了联系人搜索，"对方"即指该联系人，展示时应明确说明"以下是来自 [联系人名称] 的消息"
- 如果用户未指定联系人（全局搜索），应告知用户"以下消息来自不同联系人，sender 为'对方'表示该消息由您的某位好友发送"

---

## 数据真实性（最高优先级，绝对禁止违反）

1. **所有结论必须基于工具返回的真实数据**，禁止编造、虚构、推测、假设任何数据
2. **所有展示的数字、天数、比例、统计必须来自工具返回结果**，禁止用虚假数据填充
3. **区分"观察到的行为"与"可能的解读"**，使用概率性语言：
   - 高置信度（85%+）："可以较为确定地认为..."
   - 中置信度（60-85%）："有较高可能性..."
   - 低置信度（<60%）："存在一种可能性..."
4. **禁止对用户性格/人格进行定性判断**（如"TA是回避型人格"）
5. **禁止推测聊天记录之外的情境或心理活动**
6. **工具调用失败或返回空数据时，如实告知用户**，禁止用"示例数据"掩盖
7. **语音转写特殊要求**：只展示 transcripts 数组中的内容，禁止编造语音内容。数组为空时必须明确告知"没有成功转写的语音内容"
8. **时间范围验证**：分析聊天数据时，必须注意工具返回数据的时间范围。如果好友是最近才添加的，不要展示或引用好友添加之前的日期数据。以工具返回的 firstActiveDate 或实际有消息的最早日期为准。
9. **消息类型如实描述**：工具返回的消息中，非文字消息会以 [图片]、[语音 X秒]、[链接] 标题 等格式展示。描述时如实引用工具返回的内容即可，不要自行推断消息的具体类型（如将普通链接推断为"音乐分享"或"文章分享"）。
10. **【生日/纪念日/年龄等敏感信息 - 必须使用 anniversary_finder LLM智能分析】**
    - **禁止凭空推断生日！必须使用 anniversary_finder 工具**
    - anniversary_finder 使用 LLM 智能分析聊天记录，比机械关键词匹配更准确
    - 当用户询问某人的生日时：
      1. **必须调用 anniversary_finder 工具**获取智能分析结果
      2. **根据返回字段判断**：
         - contactBirthday 字段有值 → 这是对方的生日
         - userBirthday 字段有值 → 这是你的生日
         - 查看 confidence 字段了解置信度（>0.8 高可信，0.5-0.8 中等，<0.5 低可信需确认）
         - 查看 rawContent 中的原始消息了解分析依据
      3. **可以告诉用户具体日期**，因为这是从聊天记录中提取的真实数据
      4. **添加免责声明**：生日判断基于聊天记录中的祝福消息，祝福可能不是当天发送的
    - **支持识别多种特殊日子**：生日、节日（春节/中秋/圣诞等）、纪念日、相识纪念
11. **【关系状态/情感状态 - 严禁推断】**
    - 绝对禁止推断两人是否为情侣、恋人、夫妻关系
    - 绝对禁止推断对方的恋爱状态、婚姻状态
    - 可以描述互动模式（如"频繁互道晚安"），但不能下定性结论

---

## 分析框架

### 三维分析视角
- **情感维度**：情绪基调、强度、表达风格（直接/暗示/压抑）
- **认知维度**：认知复杂度、归因风格、话题深度
- **行为维度**：主动性、回应性、一致性

### 心理学理论应用
适当引用理论增强专业性：依恋理论（安全型/焦虑型/回避型）、沟通理论、社会交换理论。
格式："根据[理论名称]，[观察到的现象]可能反映了[理论概念]..."

---

## 沟通风格规范

### 结构化输出
分析报告按以下结构组织：
1. **现象描述**（纯客观）— 基于数据的事实陈述
2. **分析解读**（含置信度）— 引用数据支撑，提供多角度解读
3. **建议指导** — 具体、可操作的建议
4. **局限性声明** — 本分析的局限和需进一步确认的信息

### 专业但易懂
- 使用准确术语但提供通俗解释，如"回避型依恋倾向（即面对亲密时倾向于保持距离）"
- 共情但不越界，使用"我能理解..."等表达，避免过度共情
- 避免"高情商话术"风格，不过度热情或使用过多感叹号、表情符号
- 回复建议应自然得体，像正常人一样说话，不强行推进关系或过度关心

---

## 工具调用策略

### 何时调用工具
- 用户要求分析特定联系人时 → 必须先调用工具获取数据
- 用户要求生成回复建议时 → 必须先获取该联系人的最近聊天记录
- 用户意图明确需要数据支持时 → 主动调用工具，不要等待用户明确要求

### 工具选择原则
- **先确认联系人**：分析特定联系人前，如果不确定联系人名称，先调用 list_all_contacts
- **单工具 vs 多工具**：简单问题用单工具，复杂分析（如"全面分析关系"）可组合多个工具
- **工具间区别**：
  - chat_summary = 聊天内容摘要（看了什么、聊了什么）
  - relationship_health = 关系健康度评分（五个维度量化评估）
  - emotion_calendar = 聊天频率日历（每天聊了多少条）
  - message_classification = 消息分类标记（约定、金额、日期、地址等）
  - promise_tracker = 承诺/约定追踪（谁答应了什么、完成状态）
  - **anniversary_finder = 特殊日子LLM智能分析工具**（核心工具！必须优先使用）：
    - **支持类型**：生日、纪念日、节日庆祝、相识纪念、关系进展
    - **智能分析**：使用 LLM 深度理解聊天上下文，智能识别特殊日子
    - **返回结构**：
      - userBirthday: 你的生日（包含日期、置信度、原始消息）
      - contactBirthday: 对方的生日（包含日期、置信度、原始消息）
      - holidays: 节日庆祝列表
      - relationships: 纪念日列表
      - summary: LLM分析摘要
    - **【重要】查找生日/纪念日/任何特殊日子时必须使用 anniversary_finder**

### 错误处理
- 联系人找不到 → 告知用户，展示相似联系人列表供选择
- 工具返回空数据 → 如实告知"该联系人没有相关数据"
- 工具调用失败 → 告知用户失败原因，建议尝试其他工具或调整参数

---

## 意图识别

### 功能咨询（不调用工具）
用户询问应用功能、使用方法时，直接回答。ChatFlow 主要功能：聊天记录查看、朋友圈浏览、通讯录管理、AI分析、聊天统计、年度报告、导出。设置入口：左下角头像→设置。

### 测试请求（必须真实调用）
1. **必须逐个真实调用工具**，展示实际返回数据
2. **禁止编造测试结果** — 没调用的工具不得声称"测试通过"
3. 每次只测 1-2 个，展示真实结果后再继续
4. **【强制】需要联系人的工具，必须先询问用户指定哪个联系人**
   - 绝对禁止自行选择联系人进行测试
   - 绝对禁止使用"G"、"某某"等占位符或示例联系人
   - 绝对禁止从联系人列表中随机挑选联系人
   - 必须在用户明确指定联系人名称后，才能调用需要 contactName 的工具
5. **【强制】搜索类工具的搜索词必须由用户提供**
   - 绝对禁止自行编造搜索关键词（如"会议"、"test"等）
   - 必须在用户明确提供搜索词后，才能调用搜索工具
6. **如果用户没有提供搜索词或联系人，必须主动询问，等待用户回复，严禁自作主张自行决定

---

## 对话上下文
- 关联多轮对话中的指代（"他"、"这个联系人"、"刚才说的"等）
- 上文提到的联系人，后续问题默认指代该联系人

---

## 专业边界
- 分析基于工具返回的数据，不同工具覆盖的时间范围和数据维度不同
- AI无法获取非语言信息（语气、表情、肢体语言）
- **本分析不构成心理咨询、治疗建议或关系指导**
- 建议寻求专业帮助的情况：身体/情感虐待、自伤念头、长期沟通障碍严重影响生活质量

---

## 思考过程（重要）
在回复用户之前，先在内心进行以下思考（不要输出思考过程，只在内部推理）：
1. **用户意图**：用户真正想要什么？是数据分析、功能咨询、还是情感建议？
2. **数据需求**：回答这个问题需要哪些数据？应该调用哪个工具？
3. **身份确认**：如果涉及特定联系人，用户指的是谁？
4. **结论验证**：我要展示的每个数据点，是否都来自工具返回结果？有没有编造的？
5. **输出组织**：如何组织回复才能既专业又有帮助？`
}

/**
 * Agent Engine 类
 */
export class AgentEngine {
  private loop: AgentLoop | null = null
  private config: AgentConfig

  constructor(config: AgentConfig) {
    this.config = {
      temperature: 0.7,
      maxTokens: 4096,
      maxIterations: 50,
      ...config
    }
  }

  /**
   * 处理用户消息
   * 兼容旧版API：processMessage(content, history, onToolCall, onStream, options)
   * 新版API：processMessage(content, history, onToolCall, onToolProgress, onStream, options)
   */
  async processMessage(
    userMessage: string,
    historyOrCallbacks?: any[] | AgentCallbacks | ProcessMessageOptions,
    onToolCall?: (toolName: string, args: any) => void,
    onToolProgressOrStream?: (toolName: string, current: number, total: number, message?: string) => void | ((chunk: string) => void),
    onStreamOrOptions?: ((chunk: string) => void) | ProcessMessageOptions,
    options?: ProcessMessageOptions
  ): Promise<AgentMessage> {
    let callbacks: AgentCallbacks = {}
    let history: any[] = []
    let bgOptions: ProcessMessageOptions = {}

    if (Array.isArray(historyOrCallbacks)) {
      history = historyOrCallbacks
      // 判断是新版还是旧版调用方式：
      // 新版有4个回调参数（onToolCall, onToolProgress, onStream, options）
      // 旧版有3个回调参数（onToolCall, onStream, options）
      // 通过检查第4个参数 onStreamOrOptions 是否为函数来区分
      if (onStreamOrOptions && typeof onStreamOrOptions === 'function') {
        // 新版：onToolCall, onToolProgress, onStream, options
        callbacks = {
          onToolCall: onToolCall,
          onToolProgress: onToolProgressOrStream as (toolName: string, current: number, total: number, message?: string) => void,
          onStream: onStreamOrOptions as (chunk: string) => void,
        }
        bgOptions = options || {}
      } else {
        // 旧版：onToolCall, onStream, options
        callbacks = {
          onToolCall: onToolCall,
          onStream: onToolProgressOrStream as (chunk: string) => void,
        }
        bgOptions = (onStreamOrOptions as ProcessMessageOptions) || {}
      }
    } else if (typeof historyOrCallbacks === 'object' && !Array.isArray(historyOrCallbacks)) {
      const opts = historyOrCallbacks as any
      if ('background' in opts || 'onProgress' in opts || 'onComplete' in opts || 'onError' in opts) {
        bgOptions = opts as ProcessMessageOptions
        callbacks = {
          onToolCall: bgOptions.onProgress,
          onStream: bgOptions.onProgress,
        }
      } else {
        callbacks = historyOrCallbacks || {}
      }
    }

    if (bgOptions.background) {
      return this.executeInBackground(userMessage, history, callbacks, bgOptions)
    }

    return this.executeSync(userMessage, history, callbacks)
  }

  private async executeInBackground(
    userMessage: string,
    history: any[],
    callbacks: AgentCallbacks,
    options: ProcessMessageOptions
  ): Promise<AgentMessage> {
    console.log('[AgentEngine] 后台模式执行开始')

    const executeFn = async (): Promise<AgentMessage> => {
      if (options.signal?.aborted) {
        throw new DOMException('任务已取消', 'AbortError')
      }
      return this.executeSync(userMessage, history, callbacks, options.signal)
    }

    try {
      const result = await executeFn()
      if (options.onComplete) {
        options.onComplete(result)
      }
      return result
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        console.log('[AgentEngine] 后台任务被取消')
        if (options.onError) {
          options.onError(error)
        }
        throw error
      }

      console.error('[AgentEngine] 后台任务执行失败:', error)
      if (options.onError) {
        options.onError(error)
      }
      throw error
    }
  }

  private async executeSync(
    userMessage: string,
    history: any[],
    callbacks: AgentCallbacks,
    signal?: AbortSignal
  ): Promise<AgentMessage> {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // 创建Logger
    const logger = createAgentLogger(sessionId, {
      consoleOutput: true,
      minLevel: 'DEBUG' as any
    })

    logger.info(LogStage.SESSION_START, {
      userInput: userMessage,
      historyLength: history.length,
      config: {
        model: this.config.model,
        temperature: this.config.temperature
      }
    })

    try {
      // 创建Agent Loop
      this.loop = new AgentLoop(this.config, logger, callbacks)

      // 加载历史消息（多轮对话上下文）
      if (history.length > 0) {
        this.loop.loadHistory(history)
      }

      // 注册所有工具
      const tools = getAllTools()
      const toolsDescription = tools.map(t =>
        `- ${t.name}: ${t.description}`
      ).join('\n')

      // 使用buildOpenAIFunctionTools生成正确的OpenAI Function Calling格式
      const openAITools = buildOpenAIFunctionTools()
      for (const toolDef of openAITools) {
        const tool = tools.find(t => t.name === toolDef.function.name)
        if (tool) {
          this.loop.registerTool(
            tool.name,
            toolDef,
            // 包装函数：将 AgentLoop 传来的 (args, signal, onProgress) 映射到 tool.execute(args, onProgress)
            (args: any, _signal: AbortSignal, onProgress?: (current: number, total: number, message?: string) => void) =>
              tool.execute(args, onProgress)
          )
        }
      }

      // 获取当前用户昵称
      let myDisplayName: string | undefined
      try {
        const myAvatarResult = await window.electronAPI.chat.getMyAvatarUrl()
        if (myAvatarResult?.success && myAvatarResult.displayName) {
          myDisplayName = myAvatarResult.displayName
        }
      } catch (_) {}

      // 设置System Prompt
      const systemPrompt = buildSystemPrompt(toolsDescription, tools.length, myDisplayName)
      this.loop.setSystemPrompt(systemPrompt)

      // 运行Agent（传递 signal 以支持取消）
      const result = await this.loop.run(userMessage, signal)

      // 结束会话，确保日志被写入文件
      await logger.endSession()

      return {
        id: crypto.randomUUID(),
        conversationId: '',
        role: 'assistant',
        content: result.content,
        renderType: 'markdown',
        createdAt: Date.now()
      }

    } catch (error: any) {
      const errorMessage = error?.message || '未知错误'
      
      logger.error(LogStage.SESSION_END, {
        error: errorMessage,
        stack: error?.stack
      })

      // 结束会话，确保日志被写入文件
      await logger.endSession()

      // 构建详细的错误信息
      let detailedError = `抱歉，处理过程中出现错误：${errorMessage}`
      
      // 添加日志提示 - 日志会自动保存到用户数据目录
      detailedError += '\n\n---\n💡 **日志已保存**：详细执行日志已保存到用户数据目录的 logs/agent/ 文件夹中，可用于问题排查。'
      
      return {
        id: crypto.randomUUID(),
        conversationId: '',
        role: 'assistant',
        content: detailedError,
        renderType: 'markdown',
        createdAt: Date.now()
      }
    }
  }

  /**
   * 获取当前状态
   */
  getState(): string {
    return this.loop?.getState() || 'IDLE'
  }

  /**
   * 更新配置
   * 用于动态更新API配置（如从授权服务获取后）
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = {
      ...this.config,
      ...config
    }
    console.log('[AgentEngine] 配置已更新:', {
      model: this.config.model,
      apiUrl: this.config.apiUrl,
      apiKey: this.config.apiKey ? '已设置' : '未设置'
    })
  }

  /**
   * 获取当前配置
   */
  getConfig(): AgentConfig {
    return { ...this.config }
  }
}

// 导出单例实例（初始使用默认配置，后续通过updateConfig更新）
export const agentEngine = new AgentEngine({
  model: 'gpt-4o',
  apiUrl: 'https://api.openai.com',
  apiKey: ''
})

// 导出类型
export type { AgentConfig, AgentResult, AgentCallbacks } from './agentTypes'
export { LogLevel, LogStage } from './agentLogger'

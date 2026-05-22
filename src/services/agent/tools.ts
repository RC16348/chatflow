import type { AgentTool, ToolResult } from '../../types/agent'
import { parseAppMessageContent, type ForwardedMessageItem, type ParsedAppMessageResult } from '../../utils/messageParser'

// ============================================================================
// 类型定义 - OpenAI Function Calling 格式
// ============================================================================

/**
 * JSON Schema 参数定义
 */
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
  enum?: string[]
  items?: ToolParameterSchema
  properties?: Record<string, ToolParameterSchema>
}

/**
 * OpenAI Function Calling 格式的工具定义
 */
export interface OpenAIFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolParameterSchema>
      required: string[]
    }
  }
}

/**
 * 统一的工具执行结果格式
 */
export interface ToolExecutionResult {
  success: boolean
  data?: any
  error?: string
  metadata?: {
    cached?: boolean
    executionTime?: number
    toolName?: string
    deduplicated?: boolean
    errorCached?: boolean
  }
}

// ============================================================================
// 工具结果缓存系统
// ============================================================================

/**
 * 工具结果缓存管理器
 * - 使用 Map 存储工具调用结果
 * - 缓存键：toolName + JSON.stringify(args)
 * - 支持缓存过期和手动清理
 */
class ToolResultCache {
  private cache: Map<string, { result: ToolExecutionResult; timestamp: number }>
  private readonly defaultTTL: number // 默认缓存时间（毫秒）

  constructor(defaultTTL: number = 5 * 60 * 1000) {
    // 默认5分钟
    this.cache = new Map()
    this.defaultTTL = defaultTTL
  }

  /**
   * 生成缓存键
   */
  private generateKey(toolName: string, args: Record<string, any>): string {
    // 对args进行排序以确保相同的参数生成相同的key
    const sortedArgs = Object.keys(args)
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key]
        return acc
      }, {} as Record<string, any>)
    return `${toolName}:${JSON.stringify(sortedArgs)}`
  }

  /**
   * 获取缓存结果
   */
  get(toolName: string, args: Record<string, any>): ToolExecutionResult | null {
    const key = this.generateKey(toolName, args)
    const cached = this.cache.get(key)

    if (!cached) return null

    // 检查是否过期
    if (Date.now() - cached.timestamp > this.defaultTTL) {
      this.cache.delete(key)
      return null
    }

    // 返回带缓存标记的结果
    return {
      ...cached.result,
      metadata: {
        ...cached.result.metadata,
        cached: true
      }
    }
  }

  /**
   * 设置缓存结果
   */
  set(toolName: string, args: Record<string, any>, result: ToolExecutionResult): void {
    const key = this.generateKey(toolName, args)
    this.cache.set(key, {
      result,
      timestamp: Date.now()
    })
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 清除特定工具的缓存
   */
  clearByToolName(toolName: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${toolName}:`)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    }
  }
}

// 全局缓存实例
export const toolResultCache = new ToolResultCache()

// ============================================================================
// 转发消息解析辅助函数
// ============================================================================

const forwardedContentCache = new Map<string, ParsedAppMessageResult>()

function extractForwardedContent(message: any): string {
  try {
    if (!message || message.localType !== 49) {
      return message?.parsedContent || message?.content || ''
    }

    const cacheKey = `${message.messageId || message.msgId || ''}_${message.content || ''}`
    if (forwardedContentCache.has(cacheKey)) {
      const cached = forwardedContentCache.get(cacheKey)!
      return formatForwardedMessage(cached)
    }

    const rawContent = message.content || message.parsedContent || ''
    if (!rawContent || typeof rawContent !== 'string') {
      return message.linkTitle || message.title || '[链接/文件]'
    }

    const parsed = parseAppMessageContent(rawContent)
    forwardedContentCache.set(cacheKey, parsed)

    return formatForwardedMessage(parsed)
  } catch (error) {
    console.warn('extractForwardedContent 解析失败:', error)
    return message?.linkTitle || message?.title || '[链接/文件]'
  }
}

function formatForwardedMessage(parsed: ParsedAppMessageResult): string {
  try {
    if (!parsed || !parsed.isForwardedChat || !parsed.forwardedMessages || parsed.forwardedMessages.length === 0) {
      if (parsed.title) {
        return `[${parsed.title}]`
      }
      return parsed.description || '[链接/文件]'
    }

    const formattedParts: string[] = []
    for (const item of parsed.forwardedMessages.slice(0, 10)) {
      const sourceName = item.sourcename || '未知'
      const contentText = item.datadesc || item.datatitle || item.content || ''

      if (item.nestedMessages && item.nestedMessages.length > 0) {
        const nestedContents = item.nestedMessages
          .map(n => n.datadesc || n.datatitle || '')
          .filter(Boolean)
          .slice(0, 3)
          .join(' | ')

        formattedParts.push(`[转发自 ${sourceName}] ${contentText}${nestedContents ? ` (${nestedContents})` : ''}`)
      } else {
        formattedParts.push(`[转发自 ${sourceName}] ${contentText}`)
      }
    }

    return formattedParts.join('\n') || `[转发聊天记录 - ${parsed.forwardedMessages.length}条消息]`
  } catch (error) {
    console.warn('formatForwardedMessage 格式化失败:', error)
    return '[转发消息]'
  }
}

function clearForwardedContentCache(): void {
  forwardedContentCache.clear()
}

// ============================================================================
// 工具执行去重系统
// ============================================================================

/**
 * 正在执行中的工具调用跟踪器 - 线程安全版本
 * 用于防止相同参数的并发工具调用重复执行
 */
class ToolExecutionDeduplicator {
  private pendingExecutions: Map<string, Promise<ToolExecutionResult>>
  private executionLocks: Map<string, boolean>

  constructor() {
    this.pendingExecutions = new Map()
    this.executionLocks = new Map()
  }

  /**
   * 生成去重键 - 深度排序确保一致性
   */
  private generateKey(toolName: string, args: Record<string, any>): string {
    try {
      const sortedArgs = this.sortObjectKeys(args)
      return `${toolName}:${JSON.stringify(sortedArgs)}`
    } catch (err) {
      // 降级方案
      return `${toolName}:${this.simpleHash(JSON.stringify(args))}`
    }
  }

  /**
   * 递归排序对象键
   */
  private sortObjectKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item))
    }
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = this.sortObjectKeys(obj[key])
        return acc
      }, {} as Record<string, any>)
  }

  /**
   * 简单的字符串哈希
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return hash.toString(16)
  }

  /**
   * 执行工具调用（带去重）- 线程安全版本
   * @param toolName 工具名称
   * @param args 工具参数
   * @param executeFn 实际执行函数
   * @returns 工具执行结果
   */
  async execute(
    toolName: string,
    args: Record<string, any>,
    executeFn: () => Promise<ToolExecutionResult>
  ): Promise<ToolExecutionResult> {
    const key = this.generateKey(toolName, args)

    // 1. 检查是否有相同参数的调用正在进行
    const pending = this.pendingExecutions.get(key)
    if (pending) {
      console.log(`[ToolExecutionDeduplicator] 复用正在进行的调用: ${key}`)
      // 返回正在进行的调用结果
      const result = await pending
      return {
        ...result,
        metadata: {
          ...result.metadata,
          deduplicated: true // 标记为去重复用结果
        }
      }
    }

    // 2. 检查是否有锁（防止竞态条件）
    if (this.executionLocks.get(key)) {
      console.log(`[ToolExecutionDeduplicator] 等待锁释放: ${key}`)
      // 等待锁释放后再次检查
      await new Promise(resolve => setTimeout(resolve, 50))
      return this.execute(toolName, args, executeFn)
    }

    // 3. 获取锁
    this.executionLocks.set(key, true)

    // 4. 再次检查（双重检查锁定模式）
    const pendingAfterLock = this.pendingExecutions.get(key)
    if (pendingAfterLock) {
      this.executionLocks.delete(key)
      const result = await pendingAfterLock
      return {
        ...result,
        metadata: {
          ...result.metadata,
          deduplicated: true
        }
      }
    }

    // 5. 创建新的执行
    const executionPromise = this.createExecution(key, executeFn)
    
    // 6. 跟踪正在进行的执行
    this.pendingExecutions.set(key, executionPromise)

    try {
      const result = await executionPromise
      return result
    } finally {
      // 7. 释放锁
      this.executionLocks.delete(key)
    }
  }

  /**
   * 创建执行Promise
   */
  private async createExecution(
    key: string,
    executeFn: () => Promise<ToolExecutionResult>
  ): Promise<ToolExecutionResult> {
    try {
      const result = await executeFn()
      return result
    } catch (err: any) {
      // 包装错误
      return {
        success: false,
        error: err?.message || err?.toString() || '执行失败',
        metadata: {
          executionTime: 0,
          cached: false
        }
      }
    } finally {
      // 执行完成后移除跟踪
      this.pendingExecutions.delete(key)
    }
  }

  /**
   * 获取正在进行的执行数量
   */
  getPendingCount(): number {
    return this.pendingExecutions.size
  }

  /**
   * 清除所有跟踪（用于调试）
   */
  clear(): void {
    this.pendingExecutions.clear()
    this.executionLocks.clear()
  }
}

// 全局去重器实例
const toolExecutionDeduplicator = new ToolExecutionDeduplicator()

// ============================================================================
// 工具执行包装器
// ============================================================================

/**
 * 统一的工具执行包装函数 - 强化版本
 * - 处理超时
 * - 统一返回格式
 * - 错误处理标准化
 * - 缓存支持
 * - 去重支持（线程安全）
 * - 结果验证
 */
async function executeToolWithWrapper(
  toolName: string,
  args: Record<string, any>,
  executeFn: (args: Record<string, any>, onProgress?: (current: number, total: number, message?: string) => void) => Promise<any>,
  options: {
    timeout?: number
    enableCache?: boolean
    enableDeduplication?: boolean
    onProgress?: (current: number, total: number, message?: string) => void
  } = {}
): Promise<ToolExecutionResult> {
  const { timeout = 30000, enableCache = true, enableDeduplication = true, onProgress } = options

  const startTime = Date.now()
  console.log(`[executeToolWithWrapper] 开始执行工具: ${toolName}`, args)

  // 1. 验证参数
  if (!toolName || typeof toolName !== 'string') {
    return {
      success: false,
      error: '工具名称无效',
      metadata: { toolName: toolName || 'unknown', executionTime: 0, cached: false }
    }
  }

  if (!args || typeof args !== 'object') {
    return {
      success: false,
      error: '工具参数无效',
      metadata: { toolName, executionTime: 0, cached: false }
    }
  }

  // 2. 检查缓存
  if (enableCache) {
    const cached = toolResultCache.get(toolName, args)
    if (cached) {
      console.log(`[executeToolWithWrapper] 命中缓存: ${toolName}`)
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          toolName,
          executionTime: Date.now() - startTime,
          cached: true
        }
      }
    }
  }

  // 3. 定义实际执行逻辑
  const doExecute = async (): Promise<ToolExecutionResult> => {
    try {
      // 验证executeFn
      if (typeof executeFn !== 'function') {
        throw new Error('执行函数无效')
      }

      // 带超时的执行，传递 progress 回调
      const result = await Promise.race([
        executeFn(args, onProgress),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`工具执行超时 (${timeout}ms)`)), timeout)
        )
      ])

      // 验证结果
      if (result === undefined || result === null) {
        throw new Error('工具返回空结果')
      }

      // 标准化成功结果
      const standardizedResult: ToolExecutionResult = {
        success: true,
        data: result,
        metadata: {
          toolName,
          executionTime: Date.now() - startTime,
          cached: false
        }
      }

      console.log(`[executeToolWithWrapper] 工具执行成功: ${toolName}, 耗时=${Date.now() - startTime}ms`)

      // 存入缓存（仅缓存成功结果）
      if (enableCache) {
        toolResultCache.set(toolName, args, standardizedResult)
      }

      return standardizedResult
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || '未知错误'
      console.error(`[executeToolWithWrapper] 工具执行失败: ${toolName}`, error)

      // 标准化错误结果
      const errorResult: ToolExecutionResult = {
        success: false,
        error: errorMessage,
        metadata: {
          toolName,
          executionTime: Date.now() - startTime,
          cached: false
        }
      }

      // 错误结果不缓存，避免重复失败请求被缓存
      // 下次调用会重新尝试执行

      return errorResult
    }
  }

  // 4. 执行（带去重）
  if (enableDeduplication) {
    return toolExecutionDeduplicator.execute(toolName, args, doExecute)
  }

  return doExecute()
}

// ============================================================================
// 辅助函数
// ============================================================================

// 带超时的异步操作包装函数（保留用于兼容性）
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(errorMessage)), timeoutMs))
  ])
}

// 联系人搜索辅助函数
function findContact(contacts: any[], searchName: string): { contact: any | null; similarContacts: string[] } {
  const trimmedName = searchName.trim()
  const lowerName = trimmedName.toLowerCase()

  if (!trimmedName || contacts.length === 0) {
    return { contact: null, similarContacts: [] }
  }

  // 过滤掉已删除好友和群聊/公众号（只保留真实好友）
  const activeContacts = contacts.filter(
    (c: any) => c.type !== 'former_friend' && c.type !== 'group' && c.type !== 'official'
  )

  // 1. 首先尝试精确匹配
  let contact = activeContacts.find(
    (c: any) => c.nickname === trimmedName || c.remark === trimmedName || c.username === trimmedName
  )

  // 2. 如果没有精确匹配，尝试不区分大小写的匹配
  if (!contact) {
    contact = activeContacts.find(
      (c: any) =>
        c.nickname?.toLowerCase() === lowerName ||
        c.remark?.toLowerCase() === lowerName ||
        c.username?.toLowerCase() === lowerName
    )
  }

  // 3. 如果还没有匹配，尝试包含匹配（支持单字符搜索）
  if (!contact) {
    contact = activeContacts.find(
      (c: any) =>
        c.nickname?.toLowerCase().includes(lowerName) || c.remark?.toLowerCase().includes(lowerName)
    )
  }

  // 4. 获取相似联系人建议（也从活跃联系人中选取）
  const similarContacts = activeContacts
    .filter((c: any) => {
      const cName = (c.nickname || c.remark || '').toLowerCase()
      return cName.includes(lowerName) || lowerName.includes(cName)
    })
    .slice(0, 5)
    .map((c: any) => c.remark || c.nickname || c.username)
    .filter(Boolean)

  return { contact, similarContacts }
}

// ============================================================================
// 工具定义 - OpenAI Function Calling 格式
// ============================================================================

// 工具 1: 聊天摘要
const chatSummaryTool: AgentTool = {
  name: 'chat_summary',
  description:
    '对指定联系人的聊天记录生成摘要。默认查询最近3天的聊天记录，如需更长时间范围请指定timeRange参数。适用于：了解聊天内容概要、补看错过消息、回顾长对话。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称或备注',
      required: true
    },
    timeRange: {
      type: 'string',
      description: '时间范围：today/this_week/this_month/this_year/custom，默认最近3天',
      required: false,
      enum: ['today', 'this_week', 'this_month', 'this_year', 'custom']
    },
    startDate: {
      type: 'string',
      description: '自定义起始日期 YYYY-MM-DD',
      required: false
    },
    endDate: {
      type: 'string',
      description: '自定义结束日期 YYYY-MM-DD',
      required: false
    },
    maxMessages: {
      type: 'number',
      description: '最大分析消息条数，默认200',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('chat_summary', args, async (args, onProgress) => {
      // 1. 获取联系人列表
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 2. 搜索联系人
      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        error.debug = { totalContacts: contacts.length, searchName: args.contactName }
        throw error
      }

      // 3. 计算时间范围（默认最近3天）
      let startTime = 0,
        endTime = Date.now() / 1000
      const now = new Date()

      if (!args.timeRange && !args.startDate) {
        // 默认查询最近3天
        startTime = new Date(now.getTime() - 3 * 86400000).getTime() / 1000
      } else {
        switch (args.timeRange) {
          case 'today':
            startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
            break
          case 'this_week':
            startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000
            break
          case 'this_month':
            startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
            break
          case 'this_year':
            startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000
            break
          case 'custom':
            if (args.startDate) startTime = new Date(args.startDate).getTime() / 1000
            if (args.endDate) endTime = new Date(args.endDate + 'T23:59:59').getTime() / 1000
            break
        }
      }

      // 4. 获取消息
      const limit = args.maxMessages || 200
      const messagesResult = await window.electronAPI.chat.getMessages(
        contact.username,
        0,
        limit,
        startTime,
        endTime
      )

      const messages = messagesResult?.messages || []

      if (!messages || messages.length === 0) {
        const error: any = new Error(
          `该时间段内没有与"${contact.remark || contact.nickname || contact.username}"的聊天记录`
        )
        error.debug = { username: contact.username, timeRange: args.timeRange || 'all' }
        throw error
      }

      // 5. 判断是否需要使用 Map-Reduce 模式
      const MESSAGE_THRESHOLD = 200
      const SEGMENT_SIZE = 100

      if (messages.length <= MESSAGE_THRESHOLD) {
        // 消息数量较少，使用原始逻辑
        return {
          contactName: contact.remark || contact.nickname || contact.username,
          username: contact.username,
          timeRange: args.timeRange || 'all',
          totalMessages: messages.length,
          timeSpan: {
            first: messages[0]?.createTime
              ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN')
              : '',
            last: messages[messages.length - 1]?.createTime
              ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN')
              : ''
          },
          sampleMessages: formatMessagesForDisplay(messages),
          analysisType: 'standard'
        }
      }

      // 6. Map-Reduce 模式：分段处理大量消息
      return await analyzeMessagesWithMapReduce(
        messages,
        contact,
        args.timeRange || 'all',
        onProgress
      )
    })
  }
}

// 工具 1.5: 群聊聊天摘要
const groupChatSummaryTool: AgentTool = {
  name: 'group_chat_summary',
  description:
    '对指定群聊的聊天记录生成摘要。默认查询最近3天的聊天记录，如需更长时间范围请指定timeRange参数。适用于：了解群聊内容概要、补看错过消息、回顾群讨论。',
  parameters: {
    groupName: {
      type: 'string',
      description: '群聊名称',
      required: true
    },
    timeRange: {
      type: 'string',
      description: '时间范围：today/this_week/this_month/this_year/custom，默认最近3天',
      required: false,
      enum: ['today', 'this_week', 'this_month', 'this_year', 'custom']
    },
    startDate: {
      type: 'string',
      description: '自定义起始日期 YYYY-MM-DD',
      required: false
    },
    endDate: {
      type: 'string',
      description: '自定义结束日期 YYYY-MM-DD',
      required: false
    },
    maxMessages: {
      type: 'number',
      description: '最大分析消息条数，默认200',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('group_chat_summary', args, async (args, onProgress) => {
      // 1. 获取群聊列表
      const result = await window.electronAPI.groupAnalytics.getGroupChats()

      if (!result || !result.success) {
        throw new Error(`获取群聊列表失败：${result?.error || '未知错误'}`)
      }

      const groups = Array.isArray(result.data) ? result.data : []

      if (groups.length === 0) {
        throw new Error('群聊列表为空')
      }

      // 2. 搜索群聊（支持模糊匹配）
      const searchName = args.groupName.toLowerCase()
      const group =
        groups.find(
          (g: any) => g.displayName?.toLowerCase() === searchName || g.username === args.groupName
        ) || groups.find((g: any) => g.displayName?.toLowerCase().includes(searchName))

      if (!group) {
        const similarGroups = groups
          .filter((g: any) => g.displayName?.toLowerCase().includes(searchName))
          .slice(0, 5)
          .map((g: any) => g.displayName)

        const error: any = new Error(`未找到群聊"${args.groupName}"`)
        error.suggestions = similarGroups.length > 0 ? similarGroups : undefined
        error.debug = { totalGroups: groups.length, searchName: args.groupName }
        throw error
      }

      // 3. 计算时间范围（默认最近3天）
      let startTime = 0,
        endTime = Date.now() / 1000
      const now = new Date()

      if (!args.timeRange && !args.startDate) {
        // 默认查询最近3天
        startTime = new Date(now.getTime() - 3 * 86400000).getTime() / 1000
      } else {
        switch (args.timeRange) {
          case 'today':
            startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
            break
          case 'this_week':
            startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000
            break
          case 'this_month':
            startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
            break
          case 'this_year':
            startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000
            break
          case 'custom':
            if (args.startDate) startTime = new Date(args.startDate).getTime() / 1000
            if (args.endDate) endTime = new Date(args.endDate + 'T23:59:59').getTime() / 1000
            break
        }
      }

      // 4. 获取群聊消息
      const limit = args.maxMessages || 200
      const messagesResult = await window.electronAPI.chat.getMessages(
        group.username,
        0,
        limit,
        startTime,
        endTime
      )

      const messages = messagesResult?.messages || []

      if (!messages || messages.length === 0) {
        const error: any = new Error(
          `该时间段内群聊"${group.displayName || args.groupName}"没有聊天记录`
        )
        error.debug = { groupId: group.username, timeRange: args.timeRange || 'all' }
        throw error
      }

      // 5. 获取群成员信息用于显示发送者名称
      const membersResult = await window.electronAPI.groupAnalytics.getGroupMembers(group.username)
      const members = membersResult?.data || []
      const memberMap = new Map(members.map((m: any) => [m.username, m.displayName || m.nickname || m.username]))

      // 6. 判断是否需要使用 Map-Reduce 模式
      const MESSAGE_THRESHOLD = 200

      if (messages.length <= MESSAGE_THRESHOLD) {
        // 消息数量较少，直接返回
        return {
          groupName: group.displayName || args.groupName,
          chatroomId: group.username,
          memberCount: group.memberCount || 0,
          timeRange: args.timeRange || 'all',
          totalMessages: messages.length,
          timeSpan: {
            first: messages[0]?.createTime
              ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN')
              : '',
            last: messages[messages.length - 1]?.createTime
              ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN')
              : ''
          },
          sampleMessages: formatGroupMessagesForDisplay(messages, memberMap),
          analysisType: 'standard'
        }
      }

      // 7. Map-Reduce 模式：分段处理大量消息
      return await analyzeGroupMessagesWithMapReduce(
        messages,
        group,
        args.timeRange || 'all',
        memberMap,
        onProgress
      )
    })
  }
}

// ============================================================================
// Map-Reduce 消息分析辅助函数
// ============================================================================

/**
 * 格式化消息用于显示
 * @param messages 消息列表
 * @param myName 用户名称
 * @param contactName 联系人名称
 */
function formatMessagesForDisplay(
  messages: any[],
  myName?: string,
  contactName?: string
): any[] {
  const me = myName || '我'
  const other = contactName || '对方'

  return messages
    .filter((m: any) => {
      let content = ''
      if (m.localType === 1) {
        content = m.parsedContent || m.content
      } else if (m.localType === 49) {
        content = extractForwardedContent(m)
      } else {
        content = m.parsedContent || m.content || ''
      }
      return content && typeof content === 'string' && content.length > 2
    })
    .map((m: any) => {
      let content = ''
      if (m.localType === 1) {
        content = m.parsedContent || m.content
      } else if (m.localType === 49) {
        content = extractForwardedContent(m)
      } else {
        content = m.parsedContent || m.content || '[非文本消息]'
      }
      const isSend = m.isSend
      const senderRole = isSend ? '我' : '对方'
      const senderName = isSend ? me : other
      return {
        sender: senderRole,
        senderRole,
        senderName,
        isCurrentUser: isSend,
        content: content.slice(0, 200),
        time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
      }
    })
}

/**
 * 将消息分割成段
 */
function splitMessagesIntoSegments(messages: any[], segmentSize: number): any[][] {
  const segments: any[][] = []
  for (let i = 0; i < messages.length; i += segmentSize) {
    segments.push(messages.slice(i, i + segmentSize))
  }
  return segments
}

/**
 * 将消息格式化为文本用于LLM分析
 * @param messages 消息列表
 * @param myName "我"的显示名称（如用户昵称），默认"我"
 * @param contactName 对方的显示名称（如联系人备注名），默认"对方"
 * @param myWxid 用户的微信ID（用于稳定身份标识）
 * @param contactWxid 联系人的微信ID（用于稳定身份标识）
 */
function formatMessagesForLLM(
  messages: any[],
  myName?: string,
  contactName?: string,
  myWxid?: string,
  contactWxid?: string
): string {
  const me = myName || '我'
  const other = contactName || '对方'
  const meId = myWxid || 'current_user'
  const otherId = contactWxid || 'contact_user'

  // 添加身份映射声明
  const identityHeader = `【身份标识说明】以下消息中：
- "${me}" (ID: ${meId}) = ChatFlow使用者（当前用户）
- "${other}" (ID: ${otherId}) = 被分析的联系人
- 每条消息格式: [序号] 时间 [发送者角色(发送者ID)] 消息内容
\n---\n`

  const messagesText = messages
    .map((m: any, index: number) => {
      let content = ''
      if (m.localType === 1) {
        content = m.parsedContent || m.content
      } else if (m.localType === 49) {
        content = extractForwardedContent(m)
      } else {
        content = m.parsedContent || m.content || '[非文本消息]'
      }
      const isSend = m.isSend
      const senderRole = isSend ? me : other
      const senderId = isSend ? meId : otherId
      const senderLabel = `${senderRole}(${senderId})`
      const time = m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
      return `[${index + 1}] ${time} [${senderLabel}]: ${content}`
    })
    .join('\n')

  return identityHeader + messagesText
}

/**
 * 调用LLM进行单段摘要（Map阶段）
 */
async function summarizeSegment(
  segment: any[],
  segmentIndex: number,
  totalSegments: number,
  config: { apiUrl: string; apiKey: string; model: string },
  myName?: string,
  contactName?: string
): Promise<SegmentSummary> {
  const messagesText = formatMessagesForLLM(segment, myName, contactName)
  const firstTime = segment[0]?.createTime
    ? new Date(segment[0].createTime * 1000).toLocaleString('zh-CN')
    : ''
  const lastTime = segment[segment.length - 1]?.createTime
    ? new Date(segment[segment.length - 1].createTime * 1000).toLocaleString('zh-CN')
    : ''

  const prompt = `请分析以下微信聊天记录片段（第 ${segmentIndex + 1}/${totalSegments} 段，时间范围：${firstTime} 至 ${lastTime}），提取关键信息并以JSON格式返回。

聊天记录：
${messagesText}

请返回以下JSON格式：
{
  "keyTopics": ["主要话题1", "主要话题2", ...],
  "emotionalTone": "整体情感基调（如：积极/消极/中性/混合，具体描述）",
  "importantEvents": ["重要事件或约定1", "重要事件或约定2", ...],
  "interactionPattern": "互动模式描述（如：谁主动、回应速度、沟通风格等）",
  "notableQuotes": ["值得注意的原话1", "值得注意的原话2"]
}

注意：
1. 只返回JSON，不要其他解释文字
2. 如果某类信息不存在，使用空数组或"无"
3. 保持客观，基于文本分析`

  try {
    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个专业的聊天记录分析助手，擅长提取关键信息和情感分析。分析应客观、克制，避免过度解读或主观臆测。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.5,
        max_tokens: 1500
      })
    })

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    // 解析JSON响应
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          segmentIndex,
          keyTopics: parsed.keyTopics || [],
          emotionalTone: parsed.emotionalTone || '中性',
          importantEvents: parsed.importantEvents || [],
          interactionPattern: parsed.interactionPattern || '',
          notableQuotes: parsed.notableQuotes || []
        }
      }
    } catch (parseError) {
      console.warn(`[summarizeSegment] JSON解析失败，使用备用方案:`, parseError)
    }

    // 备用方案：返回结构化文本
    return {
      segmentIndex,
      keyTopics: extractTopicsFallback(content),
      emotionalTone: '中性',
      importantEvents: [],
      interactionPattern: '',
      notableQuotes: []
    }
  } catch (error: any) {
    console.error(`[summarizeSegment] 段 ${segmentIndex + 1} 摘要失败:`, error)
    return {
      segmentIndex,
      keyTopics: [],
      emotionalTone: '分析失败',
      importantEvents: [],
      interactionPattern: '',
      notableQuotes: [],
      error: error.message
    }
  }
}

/**
 * 备用话题提取
 */
function extractTopicsFallback(text: string): string[] {
  const lines = text.split('\n')
  const topics: string[] = []
  for (const line of lines) {
    if (line.includes('话题') || line.includes('主题') || line.includes('讨论')) {
      const match = line.match(/[:：]\s*(.+)/)
      if (match && match[1]) {
        topics.push(match[1].trim())
      }
    }
  }
  return topics.length > 0 ? topics : ['内容分析中...']
}

/**
 * 格式化群聊消息用于显示
 * @param messages 消息列表
 * @param memberMap 群成员映射（username -> displayName）
 */
function formatGroupMessagesForDisplay(
  messages: any[],
  memberMap: Map<string, string>
): any[] {
  return messages
    .filter((m: any) => {
      let content = ''
      if (m.localType === 1) {
        content = m.parsedContent || m.content
      } else if (m.localType === 49) {
        content = extractForwardedContent(m)
      } else {
        content = m.parsedContent || m.content || ''
      }
      return content && typeof content === 'string' && content.length > 2
    })
    .map((m: any) => {
      let content = ''
      if (m.localType === 1) {
        content = m.parsedContent || m.content
      } else if (m.localType === 49) {
        content = extractForwardedContent(m)
      } else {
        content = m.parsedContent || m.content || '[非文本消息]'
      }
      const isSend = m.isSend
      const senderWxid = m.sender || m.wxid || ''
      const senderName = isSend ? '我' : (memberMap.get(senderWxid) || senderWxid || '未知')
      return {
        sender: senderName,
        senderRole: isSend ? '我' : '成员',
        senderName,
        isCurrentUser: isSend,
        content: content.slice(0, 200),
        time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
      }
    })
}

/**
 * 将群聊消息格式化为文本用于LLM分析
 * @param messages 消息列表
 * @param memberMap 群成员映射
 */
function formatGroupMessagesForLLM(
  messages: any[],
  memberMap: Map<string, string>
): string {
  return messages
    .map((m: any, index: number) => {
      let content = ''
      if (m.localType === 1) {
        content = m.parsedContent || m.content
      } else if (m.localType === 49) {
        content = extractForwardedContent(m)
      } else {
        content = m.parsedContent || m.content || '[非文本消息]'
      }
      const isSend = m.isSend
      const senderWxid = m.sender || m.wxid || ''
      const senderName = isSend ? '我' : (memberMap.get(senderWxid) || senderWxid || '未知')
      const time = m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
      return `[${index + 1}] ${time} [${senderName}]: ${content}`
    })
    .join('\n')
}

/**
 * 调用LLM进行群聊单段摘要（Map阶段）
 */
async function summarizeGroupSegment(
  segment: any[],
  segmentIndex: number,
  totalSegments: number,
  config: { apiUrl: string; apiKey: string; model: string },
  memberMap: Map<string, string>
): Promise<SegmentSummary> {
  const messagesText = formatGroupMessagesForLLM(segment, memberMap)
  const firstTime = segment[0]?.createTime
    ? new Date(segment[0].createTime * 1000).toLocaleString('zh-CN')
    : ''
  const lastTime = segment[segment.length - 1]?.createTime
    ? new Date(segment[segment.length - 1].createTime * 1000).toLocaleString('zh-CN')
    : ''

  const prompt = `请分析以下微信群聊记录片段（第 ${segmentIndex + 1}/${totalSegments} 段，时间范围：${firstTime} 至 ${lastTime}），提取关键信息并以JSON格式返回。

群聊记录：
${messagesText}

请返回以下JSON格式：
{
  "keyTopics": ["主要话题1", "主要话题2", ...],
  "emotionalTone": "整体情感基调（如：积极/消极/中性/混合，具体描述）",
  "importantEvents": ["重要事件或约定1", "重要事件或约定2", ...],
  "interactionPattern": "群聊互动模式描述（如：谁主导讨论、回应情况、氛围等）",
  "notableQuotes": ["值得注意的原话1", "值得注意的原话2"]
}

注意：
1. 只返回JSON，不要其他解释文字
2. 如果某类信息不存在，使用空数组或"无"
3. 保持客观，基于文本分析`

  try {
    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个专业的群聊记录分析助手，擅长提取关键信息和情感分析。分析应客观、克制，避免过度解读或主观臆测。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.5,
        max_tokens: 1500
      })
    })

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    // 解析JSON响应
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          segmentIndex,
          keyTopics: parsed.keyTopics || [],
          emotionalTone: parsed.emotionalTone || '中性',
          importantEvents: parsed.importantEvents || [],
          interactionPattern: parsed.interactionPattern || '',
          notableQuotes: parsed.notableQuotes || []
        }
      }
    } catch (parseError) {
      console.warn(`[summarizeGroupSegment] JSON解析失败，使用备用方案:`, parseError)
    }

    // 备用方案
    return {
      segmentIndex,
      keyTopics: extractTopicsFallback(content),
      emotionalTone: '中性',
      importantEvents: [],
      interactionPattern: '',
      notableQuotes: []
    }
  } catch (error: any) {
    console.error(`[summarizeGroupSegment] 段 ${segmentIndex + 1} 摘要失败:`, error)
    return {
      segmentIndex,
      keyTopics: [],
      emotionalTone: '分析失败',
      importantEvents: [],
      interactionPattern: '',
      notableQuotes: [],
      error: error.message
    }
  }
}

/**
 * 聚合群聊所有段摘要（Reduce阶段）
 */
async function aggregateGroupSummaries(
  summaries: SegmentSummary[],
  totalMessages: number,
  timeSpan: { first: string; last: string },
  config: { apiUrl: string; apiKey: string; model: string }
): Promise<AggregatedAnalysis> {
  const allTopics = summaries.flatMap(s => s.keyTopics)
  const allEvents = summaries.flatMap(s => s.importantEvents)
  const allQuotes = summaries.flatMap(s => s.notableQuotes)
  const emotionalTones = summaries.map(s => s.emotionalTone)

  const prompt = `请基于以下微信群聊记录分段摘要，生成整体分析报告。

时间跨度：${timeSpan.first} 至 ${timeSpan.last}
总消息数：${totalMessages}
分析段数：${summaries.length}

各段摘要：
${summaries.map((s, i) => `
--- 第 ${i + 1} 段 ---
主要话题：${s.keyTopics.join('、') || '无'}
情感基调：${s.emotionalTone}
重要事件：${s.importantEvents.join('、') || '无'}
互动模式：${s.interactionPattern || '无'}
`).join('\n')}

请返回以下JSON格式：
{
  "overallSummary": "整体群聊内容摘要（200字以内）",
  "keyTopicsTrend": "主要话题变化趋势和演变",
  "emotionalEvolution": "群聊情感基调的演变过程",
  "relationshipDynamics": "群成员互动动态分析",
  "actionItems": ["需要跟进的事项1", "需要跟进的事项2"],
  "overallTone": "整体情感基调总结",
  "recommendations": "基于分析的建议"
}

注意：只返回JSON，不要其他解释文字。`

  try {
    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个专业的群聊分析专家，擅长综合多段信息生成整体洞察。分析应基于事实，避免过度心理分析或主观判断，保持客观中立的视角。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 2000
      })
    })

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          overallSummary: parsed.overallSummary || '',
          keyTopicsTrend: parsed.keyTopicsTrend || '',
          emotionalEvolution: parsed.emotionalEvolution || '',
          relationshipDynamics: parsed.relationshipDynamics || '',
          actionItems: parsed.actionItems || [],
          overallTone: parsed.overallTone || '',
          recommendations: parsed.recommendations || '',
          allTopics: [...new Set(allTopics)],
          allEvents: [...new Set(allEvents)],
          allQuotes: [...new Set(allQuotes)],
          emotionalTones
        }
      }
    } catch (parseError) {
      console.warn(`[aggregateGroupSummaries] JSON解析失败，使用备用方案:`, parseError)
    }

    // 备用方案
    return {
      overallSummary: content.slice(0, 500),
      keyTopicsTrend: '',
      emotionalEvolution: '',
      relationshipDynamics: '',
      actionItems: [],
      overallTone: emotionalTones.join('、'),
      recommendations: '',
      allTopics: [...new Set(allTopics)],
      allEvents: [...new Set(allEvents)],
      allQuotes: [...new Set(allQuotes)],
      emotionalTones
    }
  } catch (error: any) {
    console.error(`[aggregateGroupSummaries] 聚合分析失败:`, error)
    return {
      overallSummary: '聚合分析失败，请查看分段摘要',
      keyTopicsTrend: '',
      emotionalEvolution: '',
      relationshipDynamics: '',
      actionItems: [],
      overallTone: '未知',
      recommendations: '',
      allTopics: [...new Set(allTopics)],
      allEvents: [...new Set(allEvents)],
      allQuotes: [...new Set(allQuotes)],
      emotionalTones,
      error: error.message
    }
  }
}

/**
 * 群聊 Map-Reduce 主函数
 */
async function analyzeGroupMessagesWithMapReduce(
  messages: any[],
  group: any,
  timeRange: string,
  memberMap: Map<string, string>,
  onProgress?: (current: number, total: number, message?: string) => void
): Promise<any> {
  const SEGMENT_SIZE = 100
  const segments = splitMessagesIntoSegments(messages, SEGMENT_SIZE)
  const totalSegments = segments.length

  console.log(`[analyzeGroupMessagesWithMapReduce] 开始Map-Reduce分析: ${messages.length}条消息, ${totalSegments}段`)

  // 获取Agent配置
  const config = await getAgentConfig()

  // 如果没有 API Key，回退到标准模式
  if (!config.apiKey) {
    console.warn('[analyzeGroupMessagesWithMapReduce] API Key 为空，回退到标准分析模式')
    return {
      groupName: group.displayName,
      chatroomId: group.username,
      memberCount: group.memberCount || 0,
      timeRange,
      totalMessages: messages.length,
      analysisType: 'standard_fallback',
      warning: 'API Key 未配置，无法使用 Map-Reduce 深度分析，已回退到基础统计模式',
      messageCount: messages.length,
      firstMessageTime: messages[0]?.createTime ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN') : '',
      lastMessageTime: messages[messages.length - 1]?.createTime ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN') : ''
    }
  }

  // Map阶段：并行处理各段（限制并发数）
  const segmentSummaries: SegmentSummary[] = []
  const CONCURRENCY_LIMIT = 3

  for (let i = 0; i < segments.length; i += CONCURRENCY_LIMIT) {
    const batch = segments.slice(i, i + CONCURRENCY_LIMIT)
    const batchPromises = batch.map((segment, batchIndex) => {
      const segmentIndex = i + batchIndex
      return summarizeGroupSegment(segment, segmentIndex, totalSegments, config, memberMap)
    })

    // 报告进度
    onProgress?.(i, totalSegments, `正在分析第${i + 1}-${Math.min(i + CONCURRENCY_LIMIT, totalSegments)}段...`)

    const batchResults = await Promise.all(batchPromises)
    segmentSummaries.push(...batchResults)

    // 更新进度
    const completed = Math.min(i + CONCURRENCY_LIMIT, totalSegments)
    onProgress?.(completed, totalSegments, `已完成${completed}/${totalSegments}段分析`)
  }

  // 报告进入Reduce阶段
  onProgress?.(totalSegments, totalSegments, '正在汇总分析结果...')

  // Reduce阶段：聚合所有摘要
  const timeSpan = {
    first: messages[0]?.createTime
      ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN')
      : '',
    last: messages[messages.length - 1]?.createTime
      ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN')
      : ''
  }

  const aggregatedAnalysis = await aggregateGroupSummaries(
    segmentSummaries,
    messages.length,
    timeSpan,
    config
  )

  return {
    groupName: group.displayName,
    chatroomId: group.username,
    memberCount: group.memberCount || 0,
    timeRange,
    totalMessages: messages.length,
    timeSpan,
    analysisType: 'map_reduce',
    segmentCount: totalSegments,
    segmentSummaries: segmentSummaries.map(s => ({
      segmentIndex: s.segmentIndex + 1,
      keyTopics: s.keyTopics,
      emotionalTone: s.emotionalTone,
      importantEvents: s.importantEvents,
      interactionPattern: s.interactionPattern,
      notableQuotes: s.notableQuotes
    })),
    aggregatedAnalysis: {
      overallSummary: aggregatedAnalysis.overallSummary,
      keyTopicsTrend: aggregatedAnalysis.keyTopicsTrend,
      emotionalEvolution: aggregatedAnalysis.emotionalEvolution,
      relationshipDynamics: aggregatedAnalysis.relationshipDynamics,
      actionItems: aggregatedAnalysis.actionItems,
      overallTone: aggregatedAnalysis.overallTone,
      recommendations: aggregatedAnalysis.recommendations,
      allTopics: aggregatedAnalysis.allTopics,
      allEvents: aggregatedAnalysis.allEvents,
      notableQuotes: aggregatedAnalysis.allQuotes.slice(0, 10)
    },
    sampleMessages: formatGroupMessagesForDisplay(messages.slice(0, 100), memberMap)
  }
}

/**
 * 聚合所有段摘要（Reduce阶段）
 */
async function aggregateSummaries(
  summaries: SegmentSummary[],
  totalMessages: number,
  timeSpan: { first: string; last: string },
  config: { apiUrl: string; apiKey: string; model: string }
): Promise<AggregatedAnalysis> {
  const allTopics = summaries.flatMap(s => s.keyTopics)
  const allEvents = summaries.flatMap(s => s.importantEvents)
  const allQuotes = summaries.flatMap(s => s.notableQuotes)
  const emotionalTones = summaries.map(s => s.emotionalTone)

  const prompt = `请基于以下聊天记录分段摘要，生成整体分析报告。

时间跨度：${timeSpan.first} 至 ${timeSpan.last}
总消息数：${totalMessages}
分析段数：${summaries.length}

各段摘要：
${summaries.map((s, i) => `
--- 第 ${i + 1} 段 ---
主要话题：${s.keyTopics.join('、') || '无'}
情感基调：${s.emotionalTone}
重要事件：${s.importantEvents.join('、') || '无'}
互动模式：${s.interactionPattern || '无'}
`).join('\n')}

请返回以下JSON格式：
{
  "overallSummary": "整体聊天内容摘要（200字以内）",
  "keyTopicsTrend": "主要话题变化趋势和演变",
  "emotionalEvolution": "情感基调的演变过程",
  "relationshipDynamics": "关系动态分析（亲密度、权力平衡等）",
  "actionItems": ["需要跟进的事项1", "需要跟进的事项2"],
  "overallTone": "整体情感基调总结",
  "recommendations": "基于分析的建议"
}

注意：只返回JSON，不要其他解释文字。`

  try {
    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个专业的关系分析专家，擅长综合多段信息生成整体洞察。分析应基于事实，避免过度心理分析或主观判断，保持客观中立的视角。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.6,
        max_tokens: 2000
      })
    })

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          overallSummary: parsed.overallSummary || '',
          keyTopicsTrend: parsed.keyTopicsTrend || '',
          emotionalEvolution: parsed.emotionalEvolution || '',
          relationshipDynamics: parsed.relationshipDynamics || '',
          actionItems: parsed.actionItems || [],
          overallTone: parsed.overallTone || '',
          recommendations: parsed.recommendations || '',
          allTopics: [...new Set(allTopics)],
          allEvents: [...new Set(allEvents)],
          allQuotes: [...new Set(allQuotes)],
          emotionalTones
        }
      }
    } catch (parseError) {
      console.warn(`[aggregateSummaries] JSON解析失败，使用备用方案:`, parseError)
    }

    // 备用方案
    return {
      overallSummary: content.slice(0, 500),
      keyTopicsTrend: '',
      emotionalEvolution: '',
      relationshipDynamics: '',
      actionItems: [],
      overallTone: emotionalTones.join('、'),
      recommendations: '',
      allTopics: [...new Set(allTopics)],
      allEvents: [...new Set(allEvents)],
      allQuotes: [...new Set(allQuotes)],
      emotionalTones
    }
  } catch (error: any) {
    console.error(`[aggregateSummaries] 聚合分析失败:`, error)
    return {
      overallSummary: '聚合分析失败，请查看分段摘要',
      keyTopicsTrend: '',
      emotionalEvolution: '',
      relationshipDynamics: '',
      actionItems: [],
      overallTone: '未知',
      recommendations: '',
      allTopics: [...new Set(allTopics)],
      allEvents: [...new Set(allEvents)],
      allQuotes: [...new Set(allQuotes)],
      emotionalTones,
      error: error.message
    }
  }
}

/**
 * Map-Reduce 主函数
 */
async function analyzeMessagesWithMapReduce(
  messages: any[],
  contact: any,
  timeRange: string,
  onProgress?: (current: number, total: number, message?: string) => void
): Promise<any> {
  const SEGMENT_SIZE = 100
  const segments = splitMessagesIntoSegments(messages, SEGMENT_SIZE)
  const totalSegments = segments.length

  console.log(`[analyzeMessagesWithMapReduce] 开始Map-Reduce分析: ${messages.length}条消息, ${totalSegments}段`)

  // 获取Agent配置
  const config = await getAgentConfig()

  // 获取当前用户昵称，用于消息格式化
  let myName: string | undefined
  try {
    const myResult = await window.electronAPI.chat.getMyAvatarUrl()
    if (myResult?.success && myResult.displayName) {
      myName = myResult.displayName
    }
  } catch (_) {}

  const contactDisplayName = contact.remark || contact.nickname || contact.username

  // 如果没有 API Key，回退到标准模式
  if (!config.apiKey) {
    console.warn('[analyzeMessagesWithMapReduce] API Key 为空，回退到标准分析模式')
    return {
      contactName: contact.remark || contact.nickname || contact.username,
      username: contact.username,
      timeRange,
      totalMessages: messages.length,
      analysisType: 'standard_fallback',
      warning: 'API Key 未配置，无法使用 Map-Reduce 深度分析，已回退到基础统计模式',
      messageCount: messages.length,
      firstMessageTime: messages[0]?.createTime ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN') : '',
      lastMessageTime: messages[messages.length - 1]?.createTime ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN') : ''
    }
  }

  // Map阶段：并行处理各段（限制并发数）
  const segmentSummaries: SegmentSummary[] = []
  const CONCURRENCY_LIMIT = 3

  for (let i = 0; i < segments.length; i += CONCURRENCY_LIMIT) {
    const batch = segments.slice(i, i + CONCURRENCY_LIMIT)
    const batchPromises = batch.map((segment, batchIndex) => {
      const segmentIndex = i + batchIndex
      return summarizeSegment(segment, segmentIndex, totalSegments, config, myName, contactDisplayName)
    })

    // 报告进度
    onProgress?.(i, totalSegments, `正在分析第${i + 1}-${Math.min(i + CONCURRENCY_LIMIT, totalSegments)}段...`)

    const batchResults = await Promise.all(batchPromises)
    segmentSummaries.push(...batchResults)

    // 更新进度
    const completed = Math.min(i + CONCURRENCY_LIMIT, totalSegments)
    onProgress?.(completed, totalSegments, `已完成${completed}/${totalSegments}段分析`)
  }

  // 报告进入Reduce阶段
  onProgress?.(totalSegments, totalSegments, '正在汇总分析结果...')

  // Reduce阶段：聚合所有摘要
  const timeSpan = {
    first: messages[0]?.createTime
      ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN')
      : '',
    last: messages[messages.length - 1]?.createTime
      ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN')
      : ''
  }

  const aggregatedAnalysis = await aggregateSummaries(
    segmentSummaries,
    messages.length,
    timeSpan,
    config
  )

  return {
    contactName: contact.remark || contact.nickname || contact.username,
    username: contact.username,
    timeRange,
    totalMessages: messages.length,
    timeSpan,
    analysisType: 'map_reduce',
    segmentCount: totalSegments,
    segmentSummaries: segmentSummaries.map(s => ({
      segmentIndex: s.segmentIndex + 1,
      keyTopics: s.keyTopics,
      emotionalTone: s.emotionalTone,
      importantEvents: s.importantEvents,
      interactionPattern: s.interactionPattern,
      notableQuotes: s.notableQuotes
    })),
    aggregatedAnalysis: {
      overallSummary: aggregatedAnalysis.overallSummary,
      keyTopicsTrend: aggregatedAnalysis.keyTopicsTrend,
      emotionalEvolution: aggregatedAnalysis.emotionalEvolution,
      relationshipDynamics: aggregatedAnalysis.relationshipDynamics,
      actionItems: aggregatedAnalysis.actionItems,
      overallTone: aggregatedAnalysis.overallTone,
      recommendations: aggregatedAnalysis.recommendations,
      allTopics: aggregatedAnalysis.allTopics,
      allEvents: aggregatedAnalysis.allEvents,
      notableQuotes: aggregatedAnalysis.allQuotes.slice(0, 10)
    },
    sampleMessages: formatMessagesForDisplay(messages.slice(0, 100))
  }
}

/**
 * 获取Agent配置
 */
async function getAgentConfig(): Promise<{ apiUrl: string; apiKey: string; model: string }> {
  // 从 agentEngine 获取运行时配置（而非 config.get，因为 Agent 配置是在运行时通过 updateConfig 注入的）
  try {
    const { agentEngine } = await import('./agentEngine')
    const config = agentEngine.getConfig()
    if (config.apiKey) {
      return { apiUrl: config.apiUrl, apiKey: config.apiKey, model: config.model }
    }
  } catch (error) {
    console.warn('[getAgentConfig] 从 agentEngine 获取配置失败:', error)
  }

  // 降级：尝试从 electronAPI 获取
  try {
    const apiUrl = (await window.electronAPI.config.get('agentApiUrl') as string) || 'https://api.openai.com'
    const apiKey = (await window.electronAPI.config.get('agentApiKey') as string) || ''
    const model = (await window.electronAPI.config.get('agentModel') as string) || 'gpt-4o'
    if (apiKey) {
      return { apiUrl, apiKey, model }
    }
  } catch (error) {
    console.warn('[getAgentConfig] 从 config.get 获取配置失败:', error)
  }

  // 最终降级：使用默认值（Map-Reduce 将不可用，会回退到标准模式）
  console.warn('[getAgentConfig] 无法获取 API 配置，Map-Reduce 模式将不可用')
  return {
    apiUrl: 'https://api.openai.com',
    apiKey: '',
    model: 'gpt-4o'
  }
}

// 类型定义
interface SegmentSummary {
  segmentIndex: number
  keyTopics: string[]
  emotionalTone: string
  importantEvents: string[]
  interactionPattern: string
  notableQuotes: string[]
  error?: string
}

interface AggregatedAnalysis {
  overallSummary: string
  keyTopicsTrend: string
  emotionalEvolution: string
  relationshipDynamics: string
  actionItems: string[]
  overallTone: string
  recommendations: string
  allTopics: string[]
  allEvents: string[]
  allQuotes: string[]
  emotionalTones: string[]
  error?: string
}

// 工具 2: 智能搜索
const smartSearchTool: AgentTool = {
  name: 'smart_search',
  description:
    '用自然语言搜索聊天记录，提取关键词进行搜索。适用于：找历史消息、找约定/承诺/金额/地址等。搜索范围为全部历史消息。返回结果包含 contactName（指定联系人时为联系人名称）、isGlobalSearch（是否全局搜索）、messages 数组（每条含 sender/content/time，sender 为"我"或"对方"）。',
  parameters: {
    query: {
      type: 'string',
      description: '自然语言搜索描述，如"上次说周末去哪吃饭"',
      required: true
    },
    contactName: {
      type: 'string',
      description: '限定搜索的联系人（可选）',
      required: false
    },
    limit: {
      type: 'number',
      description: '返回结果数量，默认20',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('smart_search', args, async (args, onProgress) => {
      const limit = args.limit || 20

      console.log(`[smart_search] 搜索参数: query="${args.query}", contactName="${args.contactName || ''}"`)

      // 如果指定了联系人，先查找联系人
      let sessionId = ''
      let contactDisplayName = ''
      if (args.contactName) {
        const result = await window.electronAPI.chat.getContacts({ lite: true })
        if (result?.success) {
          const contacts = Array.isArray(result.contacts) ? result.contacts : []
          const { contact } = findContact(contacts, args.contactName)
          if (contact) {
            sessionId = contact.username
            contactDisplayName = contact.remark || contact.nickname || contact.username || args.contactName
            console.log(`[smart_search] 找到联系人: ${contact.username}`)
          } else {
            console.log(`[smart_search] 未找到联系人: ${args.contactName}`)
          }
        }
      }

      console.log(`[smart_search] 调用搜索API: keyword="${args.query}", sessionId="${sessionId}"`)
      const resultsResult = await window.electronAPI.chat.searchMessages(args.query, sessionId, limit)
      console.log(`[smart_search] 搜索结果: success=${resultsResult?.success}, messages count=${resultsResult?.messages?.length || 0}`)

      const results = resultsResult?.messages || []

      if (!results || results.length === 0) {
        throw new Error(
          args.contactName ? `未找到与"${args.contactName}"相关的消息` : '未找到相关消息'
        )
      }

      // 构建身份映射表
      const identityMap = {
        currentUser: { role: '我', description: 'ChatFlow使用者（当前用户）' },
        contact: { role: '对方', description: contactDisplayName || '被分析的联系人' }
      }

      return {
        query: args.query,
        contactName: contactDisplayName || args.contactName || '',
        isGlobalSearch: !args.contactName,
        totalResults: results.length,
        identityMap,
        messages: results.slice(0, limit).map((m: any) => {
          // 获取消息类型（支持多种字段名）
          const localType = m.localType ?? m.local_type ?? m.WCDB_CT_local_type ?? 0

          // 获取消息内容（支持多种字段名）
          const rawContent = m.parsedContent ?? m.parsed_content ?? m.message_content ?? m.content ?? m.str_content ?? m.msg_content ?? ''

          // 获取发送者（使用 isSend 字段区分"我"和"对方"）
          const isSend = m.isSend ?? m.is_send ?? false
          const senderRole = isSend ? '我' : '对方'
          const senderName = isSend ? identityMap.currentUser.description : identityMap.contact.description

          // 获取时间（支持多种字段名和时间格式）
          const createTime = m.createTime ?? m.create_time ?? m.timestamp ?? m.time ?? 0

          // 根据消息类型格式化内容
          let content = ''
          if (localType === 1) {
            content = rawContent || '[文本消息]'
          } else if (localType === 3) {
            content = rawContent || '[图片]'
          } else if (localType === 34) {
            const duration = m.voiceDurationSeconds ?? m.voice_duration ?? m.duration ?? '?'
            content = rawContent || `[语音 ${duration}秒]`
          } else if (localType === 43) {
            content = rawContent || '[视频]'
          } else if (localType === 47) {
            content = rawContent || '[表情]'
          } else if (localType === 49) {
            content = extractForwardedContent(m) || rawContent || '[链接/文件]'
          } else if (localType === 10000 || localType === 10002) {
            content = '[系统消息]'
          } else {
            content = rawContent || `[消息类型:${localType}]`
          }

          return {
            sender: senderRole,
            senderRole,
            senderName,
            isCurrentUser: isSend,
            content: String(content).slice(0, 300),
            time: createTime ? new Date(createTime * 1000).toLocaleString('zh-CN') : ''
          }
        })
      }
    })
  }
}

// 工具 3: 回复建议
const replySuggestionTool: AgentTool = {
  name: 'reply_suggestion',
  description: '基于聊天上下文，为用户生成回复建议。适用于：不知道怎么回消息、需要高情商回复。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    contextCount: {
      type: 'number',
      description: '读取最近多少条消息作为上下文，默认20',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('reply_suggestion', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      const messagesResult = await window.electronAPI.chat.getLatestMessages(
        contact.username,
        args.contextCount || 20
      )

      const messages = messagesResult?.messages || []

      if (!messages || messages.length === 0) {
        throw new Error('没有最近的聊天记录')
      }

      const contactDisplayName = contact.remark || contact.nickname || contact.username

      // 构建身份映射表
      const identityMap = {
        currentUser: { role: '我', description: 'ChatFlow使用者（当前用户）' },
        contact: { role: '对方', description: contactDisplayName }
      }

      return {
        contactName: contactDisplayName,
        identityMap,
        recentMessages: messages.map((m: any) => {
          // 根据消息类型获取内容
          let content = ''
          const localType = m.localType

          if (localType === 1) {
            // 文本消息 - 使用 parsedContent
            content = m.parsedContent || m.content || '[文本消息]'
          } else if (localType === 3) {
            content = m.parsedContent || '[图片]'
          } else if (localType === 34) {
            content = m.parsedContent || `[语音 ${m.voiceDurationSeconds || '?'}秒]`
          } else if (localType === 43) {
            content = m.parsedContent || '[视频]'
          } else if (localType === 47) {
            content = m.parsedContent || '[表情]'
          } else if (localType === 49) {
            content = extractForwardedContent(m) || m.parsedContent || m.linkTitle || '[链接/文件]'
          } else if (localType === 10000 || localType === 10002) {
            content = '[系统消息]'
          } else {
            // 其他类型，尝试使用 parsedContent
            content = m.parsedContent || m.content || `[消息类型:${localType}]`
          }

          const isSend = m.isSend
          const senderRole = isSend ? '我' : '对方'
          const senderName = isSend ? identityMap.currentUser.description : identityMap.contact.description

          return {
            sender: senderRole,
            senderRole,
            senderName,
            isCurrentUser: isSend,
            content: content.slice(0, 300),
            time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
          }
        })
      }
    })
  }
}

// 工具 4: 对话开场白建议
const conversationStarterTool: AgentTool = {
  name: 'conversation_starter',
  description:
    '基于联系人的最近20条聊天记录和最近10条朋友圈，生成3-5个对话开场白建议。适用于：想主动发起聊天但不知道说什么、寻找合适的话题切入点。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('conversation_starter', args, async (args, onProgress) => {
      // 1. 获取联系人列表
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      // 2. 获取最近20条消息
      const messagesResult = await window.electronAPI.chat.getLatestMessages(
        contact.username,
        20
      )

      const messages = messagesResult?.messages || []

      // 3. 获取最近10条朋友圈
      const snsResult = await window.electronAPI.sns.getTimeline(10, 0, [contact.username])
      const posts = snsResult?.timeline || []

      // 4. 处理聊天记录
      const recentMessages = messages.map((m: any) => {
        let content = ''
        const localType = m.localType

        if (localType === 1) {
          content = m.parsedContent || m.content || '[文本消息]'
        } else if (localType === 3) {
          content = m.parsedContent || '[图片]'
        } else if (localType === 34) {
          content = m.parsedContent || `[语音 ${m.voiceDurationSeconds || '?'}秒]`
        } else if (localType === 43) {
          content = m.parsedContent || '[视频]'
        } else if (localType === 47) {
          content = m.parsedContent || '[表情]'
        } else if (localType === 49) {
          content = extractForwardedContent(m) || m.parsedContent || m.linkTitle || '[链接/文件]'
        } else if (localType === 10000 || localType === 10002) {
          content = '[系统消息]'
        } else {
          content = m.parsedContent || m.content || `[消息类型:${localType}]`
        }

        const isSend = m.isSend
        const senderRole = isSend ? '我' : '对方'
        const senderName = isSend ? 'ChatFlow使用者' : (contact.remark || contact.nickname || '对方')

        return {
          sender: senderRole,
          senderRole,
          senderName,
          isCurrentUser: isSend,
          content: content.slice(0, 300),
          time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
        }
      })

      // 5. 处理朋友圈内容
      const recentPosts = posts.map((p: any) => ({
        content: p.contentDesc?.slice(0, 200) || '',
        time: p.createTime ? new Date(p.createTime * 1000).toLocaleString('zh-CN') : '',
        likesCount: p.likes?.length || 0,
        commentsCount: p.comments?.length || 0,
        location: p.location?.poiName || '',
        mediaCount: p.media?.length || 0
      }))

      // 6. 分析对话状态
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
      const lastMessageTime = lastMessage?.createTime
        ? new Date(lastMessage.createTime * 1000)
        : null
      const now = new Date()
      const hoursSinceLastMessage = lastMessageTime
        ? Math.round((now.getTime() - lastMessageTime.getTime()) / (1000 * 60 * 60))
        : null

      // 判断对话状态
      let conversationStatus = 'new'
      if (messages.length === 0) {
        conversationStatus = 'new'
      } else if (hoursSinceLastMessage !== null && hoursSinceLastMessage < 24) {
        conversationStatus = 'active'
      } else if (hoursSinceLastMessage !== null && hoursSinceLastMessage < 168) {
        conversationStatus = 'recent'
      } else {
        conversationStatus = 'dormant'
      }

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        conversationStatus,
        hoursSinceLastMessage,
        recentMessages: recentMessages.slice(-20),
        recentPosts,
        context: {
          hasChatHistory: messages.length > 0,
          hasSnsContent: posts.length > 0,
          totalMessages: messages.length,
          totalPosts: posts.length
        }
      }
    })
  }
}

// 工具 5: 朋友圈分析
const snsAnalysisTool: AgentTool = {
  name: 'sns_analysis',
  description:
    '分析某联系人的朋友圈内容，总结兴趣偏好、情绪变化、生活状态。适用于：了解朋友近况、分析对方状态。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    limit: {
      type: 'number',
      description: '分析最近多少条朋友圈，默认30',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('sns_analysis', args, async (args, onProgress) => {
      // 先查找联系人获取username
      const contactsResult = await window.electronAPI.chat.getContacts({ lite: true })
      let targetUsername = args.contactName

      if (contactsResult?.success) {
        const contacts = Array.isArray(contactsResult.contacts) ? contactsResult.contacts : []
        const { contact } = findContact(contacts, args.contactName)
        if (contact?.username) {
          targetUsername = contact.username
        }
      }

      const result = await window.electronAPI.sns.getTimeline(args.limit || 30, 0, [targetUsername])

      const posts = result?.timeline || []

      if (!posts || posts.length === 0) {
        throw new Error(`未找到"${args.contactName}"的朋友圈内容`)
      }

      return {
        contactName: args.contactName,
        totalPosts: posts.length,
        posts: posts.map((p: any) => ({
          content: p.contentDesc?.slice(0, 200) || '',
          time: p.createTime ? new Date(p.createTime * 1000).toLocaleString('zh-CN') : '',
          likesCount: p.likes?.length || 0,
          commentsCount: p.comments?.length || 0,
          location: p.location?.poiName || ''
        }))
      }
    })
  }
}

// 工具 5: 群聊角色分析
const groupRoleAnalysisTool: AgentTool = {
  name: 'group_role_analysis',
  description:
    '分析群聊中每个成员的角色定位（话痨、潜水者、气氛组等）。适用于：了解群成员构成、工作群分析。',
  parameters: {
    groupName: {
      type: 'string',
      description: '群聊名称',
      required: true
    },
    topMembers: {
      type: 'number',
      description: '分析前N名成员，默认10',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('group_role_analysis', args, async (args, onProgress) => {
      const result = await window.electronAPI.groupAnalytics.getGroupChats()

      const groups = result?.data || []

      // 支持模糊匹配群聊名称
      const searchName = args.groupName.toLowerCase()
      const group =
        groups.find(
          (g: any) => g.displayName?.toLowerCase() === searchName || g.username === args.groupName
        ) || groups.find((g: any) => g.displayName?.toLowerCase().includes(searchName))

      if (!group) {
        const similarGroups = groups
          .filter((g: any) => g.displayName?.toLowerCase().includes(searchName))
          .slice(0, 5)
          .map((g: any) => g.displayName)

        const error: any = new Error(`未找到群聊"${args.groupName}"`)
        error.suggestions = similarGroups.length > 0 ? similarGroups : undefined
        throw error
      }

      const rankingsResult = await window.electronAPI.groupAnalytics.getGroupMessageRanking(
        group.username,
        args.topMembers || 10
      )

      const rankings = rankingsResult?.data || []

      const activeHoursResult = await window.electronAPI.groupAnalytics.getGroupActiveHours(
        group.username
      )
      const activeHours = activeHoursResult?.data?.hourlyDistribution || {}

      return {
        groupName: group.displayName || args.groupName,
        chatroomId: group.username,
        memberCount: group.memberCount || 0,
        topMembers: rankings.map((r: any) => ({
          name: r.member?.displayName || r.member?.username,
          messageCount: r.messageCount || 0
        })),
        activeHours
      }
    })
  }
}

// 工具 6: 情绪日历
const emotionCalendarTool: AgentTool = {
  name: 'emotion_calendar',
  description:
    '分析指定联系人的聊天频率和模式，生成情绪日历数据。适用于：自我觉察、了解关系变化趋势。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    month: {
      type: 'string',
      description: '月份 YYYY-MM，默认当月',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('emotion_calendar', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        error.debug = { totalContacts: contacts.length }
        throw error
      }

      const dateCountsResult = await window.electronAPI.chat.getMessageDateCounts(contact.username)

      const dateCounts = dateCountsResult?.counts || {}

      // 过滤指定月份，且排除今天之后的日期和消息数为0的日期
      const month = args.month || new Date().toISOString().slice(0, 7)
      const todayStr = new Date().toISOString().slice(0, 10)
      const filtered = Object.entries(dateCounts)
        .filter(([date]) => date.startsWith(month) && date <= todayStr && (dateCounts as any)[date] > 0)
        .map(([date, count]) => ({ date, count }))

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        month,
        dailyMessageCounts: filtered,
        totalMessages: filtered.reduce((sum: number, d: any) => sum + (d.count || 0), 0),
        activeDays: filtered.filter((d: any) => d.count > 0).length,
        firstActiveDate: filtered.length > 0 ? filtered[0].date : null,
        note: filtered.length > 0 ? `数据范围：${filtered[0].date} 至 ${filtered[filtered.length - 1].date}，共 ${filtered.length} 天有消息` : '该月份无聊天记录'
      }
    })
  }
}

// 工具 7: 语音摘要
const voiceSummaryTool: AgentTool = {
  name: 'voice_summary',
  description: '对指定联系人的语音消息进行转写并生成摘要。适用于：不想听长语音、快速了解语音内容。返回结果中transcripts数组包含成功转写的语音内容，如果数组为空表示没有成功转写的语音。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    limit: {
      type: 'number',
      description: '处理最近多少条语音，默认10',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('voice_summary', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      const voiceMessagesResult = await window.electronAPI.chat.getAllVoiceMessages(contact.username)

      const voiceMessages = voiceMessagesResult?.messages || []

      const limit = args.limit || 10
      const recentVoices = voiceMessages.slice(0, limit)

      if (recentVoices.length === 0) {
        throw new Error(`与"${contact.remark || contact.nickname || contact.username}"没有语音消息`)
      }

      // 尝试获取转写文本
      const transcripts: Array<{
        time: string
        transcript: string
        duration: number
        status: string
        localId: string
        sender?: string
      }> = []
      let successCount = 0
      let failCount = 0
      const failedDetails: string[] = []

      for (let i = 0; i < recentVoices.length; i++) {
        const v = recentVoices[i]

        // 报告进度
        onProgress?.(i + 1, recentVoices.length, `正在转写第 ${i + 1}/${recentVoices.length} 条语音`)

        try {
          // 获取发送者信息（用于语音转写 API）
          const senderWxid = v.senderUsername || null
          // 判断发送者身份：isSend=1 表示用户自己发的
          const isSend = v.isSend ?? false
          const senderLabel = isSend ? '我' : '对方'

          const transcriptResult = await window.electronAPI.chat.getVoiceTranscript(
            contact.username,
            String(v.localId),
            v.createTime,
            senderWxid || undefined
          )

          // 严格验证转写结果：必须成功且有非空内容
          if (transcriptResult?.success === true &&
              transcriptResult.transcript &&
              typeof transcriptResult.transcript === 'string' &&
              transcriptResult.transcript.trim().length > 0) {
            transcripts.push({
              time: v.createTime ? new Date(v.createTime * 1000).toLocaleString('zh-CN') : '',
              transcript: transcriptResult.transcript.trim(),
              duration: (v as any).voiceDurationSeconds || 0,
              status: 'success',
              localId: String(v.localId),
              sender: senderLabel
            })
            successCount++
          } else {
            // 转写结果为空或无效，记录失败详情
            failCount++
            failedDetails.push(`localId=${v.localId}, 原因=${transcriptResult?.error || '转写结果为空'}`)
          }
        } catch (err: any) {
          // 转写失败，记录失败详情
          failCount++
          failedDetails.push(`localId=${v.localId}, 异常=${err?.message || '未知错误'}`)
        }
      }

      // 返回结果，即使全部失败也返回空数组，让AI根据successCount判断
      return {
        contactName: contact.remark || contact.nickname || contact.username,
        totalVoices: recentVoices.length,
        successCount,
        failCount,
        transcripts,
        failedDetails: failedDetails.length > 0 ? failedDetails : undefined
      }
    })
  }
}

// 工具 8: 关系时间线
const relationshipTimelineTool: AgentTool = {
  name: 'relationship_timeline',
  description:
    '按月分析两人聊天的频率和模式变化，生成关系时间线。适用于：情侣回顾、年度总结。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    year: {
      type: 'number',
      description: '年份，默认当年',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('relationship_timeline', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      const year = args.year || new Date().getFullYear()

      const statsResult = await window.electronAPI.chat.getExportSessionStats([contact.username], {})

      const stats = statsResult?.data?.[contact.username] || {}

      const dateCountsResult = await window.electronAPI.chat.getMessageDateCounts(contact.username)

      const dateCounts = dateCountsResult?.counts || {}

      const yearStr = year.toString()
      const monthlyData: Record<string, number> = {}
      Object.entries(dateCounts).forEach(([date, count]) => {
        if (date.startsWith(yearStr)) {
          const month = date.slice(0, 7)
          monthlyData[month] = (monthlyData[month] || 0) + (count as number)
        }
      })

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        year,
        totalMessages: (stats as any)?.totalMessages || 0,
        monthlyData: Object.entries(monthlyData).map(([month, count]) => ({ month, count })),
        stats
      }
    })
  }
}

// ============================================================================
// LLM 智能分析特殊日子
// ============================================================================
/**
 * 使用 LLM 智能分析聊天记录，提取特殊日子
 * 核心设计：让 LLM 理解上下文和语义，而不是机械匹配关键词
 */
async function analyzeSpecialDaysWithLLM(
  messages: any[],
  contactName: string,
  analysisType: string,
  getConfig: () => Promise<{ apiUrl: string; apiKey: string; model: string }>,
  onProgress?: (current: number, total: number, message?: string) => void
): Promise<{
  specialDays: any[]
  llmAnalysis: {
    userBirthday: any
    contactBirthday: any
    holidays: any[]
    relationships: any[]
    rawMessages: any[]
  }
  summary: any
}> {
  const config = await getConfig()

  // 如果没有 API Key，回退到基础提取模式
  if (!config.apiKey) {
    console.warn('[analyzeSpecialDays] API Key 为空，回退到基础提取模式')
    return fallbackBasicAnalysis(messages, contactName, analysisType)
  }

  onProgress?.(10, 100, '正在格式化消息数据...')

  // 1. 格式化消息用于 LLM 分析
  // 只发送文字消息，且只发送相关内容（避免过多噪音）
  const relevantMessages = messages
    .filter((m: any) => {
      const content = m.parsedContent || m.content || ''
      const lower = content.toLowerCase()
      // 与特殊日子相关的关键词
      const keywords = [
        '生日', '快乐', '蛋糕', '蜡烛', '礼物', '派对',
        '纪念', '相识', '在一起', '交往', '恋爱', '结婚',
        '情人节', '七夕', '新年', '春节', '圣诞', '中秋',
        '农历', '公历', '阳历', '阴历',
        ' anniversary', 'birthday', ' anniversary'
      ]
      return keywords.some((kw: string) => lower.includes(kw)) || /\d+[月\-/]\d+/.test(content)
    })
    .slice(0, 500) // 最多500条相关消息

  const formattedMessages = relevantMessages.map((m: any, index: number) => {
    const msgDate = new Date((m.createTime || 0) * 1000)
    const sender = m.isSend ? '我' : '对方'
    const content = m.parsedContent || m.content || ''
    const displayTime = `${msgDate.getFullYear()}-${String(msgDate.getMonth() + 1).padStart(2, '0')}-${String(msgDate.getDate()).padStart(2, '0')} ${String(msgDate.getHours()).padStart(2, '0')}:${String(msgDate.getMinutes()).padStart(2, '0')}`

    // 截断过长内容
    const truncatedContent = content.length > 200 ? content.slice(0, 200) + '...' : content
    return `[${index + 1}] [${displayTime}] ${sender}：${truncatedContent}`
  })

  onProgress?.(30, 100, '正在调用 LLM 分析特殊日子...')

  // 2. 构建 LLM 分析 Prompt
  const analysisTypeMap: Record<string, string> = {
    'comprehensive': '全面分析（生日、节日、纪念日、关系进展等）',
    'birthday_only': '仅分析生日相关',
    'holidays_only': '仅分析节日庆祝',
    'anniversary_only': '仅分析纪念日和关系进展'
  }

  const analysisInstructions = analysisTypeMap[analysisType] || analysisTypeMap['comprehensive']

  const llmPrompt = `你是微信聊天记录分析专家。请分析以下与"${contactName}"的聊天记录，提取所有特殊日子和重要日期。

## 分析要求
${analysisInstructions}

## 核心规则（极其重要）
1. **发送者判断**：
   - "我" = 当前用户（ChatFlow 使用者）
   - "对方" = ${contactName}
   - "我"发送的消息 → 说的是"我"的事
   - "对方"发送的消息 → 说的是"对方"的事

2. **生日判断规则**：
   - "我生日是..." / "我是农历..." → 用户的生日
   - "你生日是..." / "你是农历..." → ${contactName}的生日
   - "生日快乐" + "我"发送 → 用户祝福${contactName} → ${contactName}的生日
   - "生日快乐" + "对方"发送 → ${contactName}祝福用户 → 用户的生日
   - **农历日期**：常见于中文聊天，必须识别并标注
   - **注意**：祝福消息的日期可能就是生日当天，但也可能是提前/延迟发送的

3. **节日判断**：
   - 新年快乐/春节 → 农历新年
   - 情人节/七夕 → 爱情相关节日
   - 圣诞快乐 → 圣诞节
   - 其他节日祝福 → 相应节日

4. **纪念日/关系进展**：
   - "在一起"/"交往"/"恋爱" → 关系开始
   - "相识"/"刚认识" → 相识纪念
   - "周年" → 纪念日
   - "结婚"/"婚礼" → 婚姻相关

## 聊天记录
${formattedMessages.join('\n')}

## 输出格式（JSON）
请返回以下 JSON 格式的结果，不要包含任何其他文字：
{
  "userBirthday": {
    "date": "农历3月28日 | 公历4月24日 | 未找到",
    "calendarType": "lunar | solar | unknown",
    "confidence": 0.0-1.0,
    "sourceMessages": ["相关消息摘要1", "相关消息摘要2"],
    "notes": "补充说明（如有）"
  },
  "contactBirthday": {
    "date": "农历6月29日 | 公历8月1日 | 未找到",
    "calendarType": "lunar | solar | unknown",
    "confidence": 0.0-1.0,
    "sourceMessages": ["相关消息摘要1"],
    "notes": "补充说明"
  },
  "holidays": [
    {
      "name": "圣诞节",
      "date": "2024-12-25",
      "sender": "我 | 对方",
      "message": "祝福消息摘要",
      "confidence": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "type": "relationship_start | anniversary | first_meeting",
      "description": "关系描述",
      "date": "2024-05-20",
      "sender": "我 | 对方",
      "message": "相关消息摘要",
      "confidence": 0.0-1.0
    }
  ],
  "summary": "一句话总结分析结果"
}`

  // 3. 调用 LLM
  try {
    const response = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'user', content: llmPrompt }
        ],
        temperature: 0.3,
        max_tokens: 4000
      })
    })

    if (!response.ok) {
      throw new Error(`LLM API 请求失败: ${response.status}`)
    }

    const data = await response.json()
    const llmContent = data.choices?.[0]?.message?.content || ''

    onProgress?.(70, 100, '正在解析 LLM 分析结果...')

    // 4. 解析 LLM 返回结果
    let llmResult: any
    try {
      // 尝试提取 JSON
      const jsonMatch = llmContent.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        llmResult = JSON.parse(jsonMatch[0])
      } else {
        throw new Error('LLM 返回内容中未找到 JSON')
      }
    } catch (parseError) {
      console.warn('[analyzeSpecialDays] LLM 返回解析失败，回退到基础模式:', parseError)
      return fallbackBasicAnalysis(messages, contactName, analysisType)
    }

    onProgress?.(90, 100, '正在格式化结果...')

    // 5. 转换为 specialDays 格式
    const specialDays: any[] = []

    // 用户生日
    if (llmResult.userBirthday?.date && llmResult.userBirthday.date !== '未找到') {
      const msgs = messages.filter((m: any) => {
        const content = (m.parsedContent || m.content || '').toLowerCase()
        return llmResult.userBirthday.sourceMessages?.some((sm: string) => content.includes(sm.slice(0, 20)))
      })
      const firstMsg = msgs[0]
      specialDays.push({
        date: firstMsg ? new Date(firstMsg.createTime * 1000).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        type: 'birthday',
        subtype: 'my_birthday',
        description: `你的生日：${llmResult.userBirthday.date}（${llmResult.userBirthday.calendarType === 'lunar' ? '农历' : '公历'}）`,
        importance: 'high',
        sender: '对方', // 对方祝福用户 → 用户的生日
        target: '我',
        inferredBirthdayDate: llmResult.userBirthday.date,
        calendarType: llmResult.userBirthday.calendarType,
        rawContent: llmResult.userBirthday.sourceMessages?.join(' | ') || '',
        confidence: llmResult.userBirthday.confidence || 0.8
      })
    }

    // 联系人生日
    if (llmResult.contactBirthday?.date && llmResult.contactBirthday.date !== '未找到') {
      const msgs = messages.filter((m: any) => {
        const content = (m.parsedContent || m.content || '').toLowerCase()
        return llmResult.contactBirthday.sourceMessages?.some((sm: string) => content.includes(sm.slice(0, 20)))
      })
      const firstMsg = msgs[0]
      specialDays.push({
        date: firstMsg ? new Date(firstMsg.createTime * 1000).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        type: 'birthday',
        subtype: 'friend_birthday',
        description: `${contactName}的生日：${llmResult.contactBirthday.date}（${llmResult.contactBirthday.calendarType === 'lunar' ? '农历' : '公历'}）`,
        importance: 'high',
        sender: '我', // 用户祝福对方 → 对方的生日
        target: '对方',
        inferredBirthdayDate: llmResult.contactBirthday.date,
        calendarType: llmResult.contactBirthday.calendarType,
        rawContent: llmResult.contactBirthday.sourceMessages?.join(' | ') || '',
        confidence: llmResult.contactBirthday.confidence || 0.8
      })
    }

    // 节日
    if (llmResult.holidays && Array.isArray(llmResult.holidays)) {
      for (const holiday of llmResult.holidays) {
        if (holiday.date && holiday.name) {
          specialDays.push({
            date: holiday.date,
            type: 'holiday',
            subtype: holiday.name,
            description: `节日祝福：${holiday.name}`,
            importance: 'medium',
            sender: holiday.sender as '我' | '对方',
            rawContent: holiday.message || '',
            confidence: holiday.confidence || 0.8
          })
        }
      }
    }

    // 关系进展
    if (llmResult.relationships && Array.isArray(llmResult.relationships)) {
      for (const rel of llmResult.relationships) {
        if (rel.date && rel.type) {
          const typeMap: Record<string, string> = {
            'relationship_start': 'relationship',
            'anniversary': 'anniversary',
            'first_meeting': 'first_contact'
          }
          specialDays.push({
            date: rel.date,
            type: typeMap[rel.type] || 'relationship',
            subtype: rel.description || rel.type,
            description: `关系进展：${rel.description || rel.type}`,
            importance: 'high',
            sender: rel.sender as '我' | '对方',
            rawContent: rel.message || '',
            confidence: rel.confidence || 0.7
          })
        }
      }
    }

    // 排序
    specialDays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    return {
      specialDays,
      llmAnalysis: {
        userBirthday: llmResult.userBirthday || { date: '未找到' },
        contactBirthday: llmResult.contactBirthday || { date: '未找到' },
        holidays: llmResult.holidays || [],
        relationships: llmResult.relationships || [],
        rawMessages: formattedMessages
      },
      summary: {
        totalSpecialDays: specialDays.length,
        birthdayCount: specialDays.filter((d: any) => d.type === 'birthday').length,
        holidayCount: specialDays.filter((d: any) => d.type === 'holiday').length,
        relationshipCount: specialDays.filter((d: any) => d.type === 'relationship' || d.type === 'anniversary').length,
        conversationDays: Math.ceil((Date.now() / 1000 - (messages[0]?.createTime || 0)) / 86400),
        totalMessages: messages.length,
        llmSummary: llmResult.summary || ''
      }
    }

  } catch (error: any) {
    console.error('[analyzeSpecialDays] LLM 分析失败，回退到基础模式:', error)
    return fallbackBasicAnalysis(messages, contactName, analysisType)
  }
}

/**
 * 基础提取模式（当 LLM 不可用时）
 */
function fallbackBasicAnalysis(messages: any[], contactName: string, analysisType: string): {
  specialDays: any[]
  llmAnalysis: any
  summary: any
} {
  console.log('[analyzeSpecialDays] 使用基础关键词提取模式')

  const specialDays: any[] = []
  const birthdayKeywords = ['生日快乐', 'happy birthday', '生日', '🎂', '蜡烛', '礼物']
  const holidayKeywords = ['新年', '春节', '情人节', '七夕', '圣诞', '中秋', '元旦']
  const relationKeywords = ['在一起', '交往', '相识', '纪念日', '周年', '结婚']

  const seenDates = new Set<string>()

  for (const msg of messages) {
    const content = (msg.parsedContent || msg.content || '').toLowerCase()
    const sender = msg.isSend ? '我' : '对方'
    const msgDate = new Date(msg.createTime * 1000)
    const dateKey = `${msgDate.toISOString().split('T')[0]}`

    // 生日
    if (birthdayKeywords.some((kw: string) => content.includes(kw.toLowerCase()))) {
      const key = `${dateKey}_birthday`
      if (!seenDates.has(key)) {
        seenDates.add(key)
        specialDays.push({
          date: dateKey,
          type: 'birthday',
          subtype: sender === '对方' ? 'my_birthday' : 'friend_birthday',
          description: `生日相关消息（${sender}发送）`,
          importance: 'high',
          sender,
          target: sender === '对方' ? '我' : '对方',
          rawContent: (msg.parsedContent || msg.content || '').slice(0, 100),
          confidence: 0.7
        })
      }
    }

    // 节日
    if (holidayKeywords.some((kw: string) => content.includes(kw))) {
      const key = `${dateKey}_holiday`
      if (!seenDates.has(key)) {
        seenDates.add(key)
        specialDays.push({
          date: dateKey,
          type: 'holiday',
          subtype: '节日祝福',
          description: `节日相关消息（${sender}发送）`,
          importance: 'medium',
          sender,
          rawContent: (msg.parsedContent || msg.content || '').slice(0, 100),
          confidence: 0.7
        })
      }
    }

    // 关系
    if (relationKeywords.some((kw: string) => content.includes(kw))) {
      const key = `${dateKey}_relation`
      if (!seenDates.has(key)) {
        seenDates.add(key)
        specialDays.push({
          date: dateKey,
          type: 'relationship',
          subtype: '关系进展',
          description: `关系相关消息（${sender}发送）`,
          importance: 'high',
          sender,
          rawContent: (msg.parsedContent || msg.content || '').slice(0, 100),
          confidence: 0.6
        })
      }
    }
  }

  specialDays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return {
    specialDays,
    llmAnalysis: {
      userBirthday: { date: '未找到（LLM不可用）' },
      contactBirthday: { date: '未找到（LLM不可用）' },
      holidays: [],
      relationships: [],
      rawMessages: [],
      note: '基础模式：仅检测到消息，未提取具体日期'
    },
    summary: {
      totalSpecialDays: specialDays.length,
      birthdayCount: specialDays.filter((d: any) => d.type === 'birthday').length,
      holidayCount: specialDays.filter((d: any) => d.type === 'holiday').length,
      relationshipCount: specialDays.filter((d: any) => d.type === 'relationship').length,
      conversationDays: Math.ceil((Date.now() / 1000 - (messages[0]?.createTime || 0)) / 86400),
      totalMessages: messages.length,
      llmSummary: '基础模式：仅做关键词检测，详细信息请配置 LLM API'
    }
  }
}

// 工具 9: 纪念日查找器
const anniversaryFinderTool: AgentTool = {
  name: 'anniversary_finder',
  description:
    '【LLM智能分析】深度分析聊天记录，智能提取所有重要日期和特殊日子。支持：生日、纪念日、节日、相识纪念、关系进展等。使用 LLM 理解上下文和语义，返回结构化数据。返回结果中的"我"表示当前用户，"对方"表示指定的联系人。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称（对方）',
      required: true
    },
    analysisType: {
      type: 'string',
      description: '分析类型：comprehensive(全面分析)/birthday_only(仅生日)/holidays_only(仅节日)/anniversary_only(仅纪念日)',
      required: false,
      enum: ['comprehensive', 'birthday_only', 'holidays_only', 'anniversary_only']
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('anniversary_finder', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []
      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      const contactDisplayName = contact.remark || contact.nickname || contact.username

      // 获取消息
      const messagesResult = await window.electronAPI.chat.getMessages(
        contact.username,
        0,
        5000,
        0,
        Date.now() / 1000
      )

      const messages = messagesResult?.messages || []

      if (!messages || messages.length === 0) {
        throw new Error(`与"${contactDisplayName}"没有聊天记录`)
      }

      // 按时间排序
      const sortedMessages = [...messages].sort((a: any, b: any) => (a.createTime || 0) - (b.createTime || 0))

      onProgress?.(5, 100, '正在获取配置...')

      // 获取 API 配置
      const getConfig = async (): Promise<{ apiUrl: string; apiKey: string; model: string }> => {
        try {
          const { agentEngine } = await import('./agentEngine')
          const config = agentEngine.getConfig()
          if (config.apiKey) {
            return { apiUrl: config.apiUrl, apiKey: config.apiKey, model: config.model }
          }
        } catch (_) {}

        try {
          const apiUrl = (await window.electronAPI.config.get('agentApiUrl') as string) || 'https://api.openai.com'
          const apiKey = (await window.electronAPI.config.get('agentApiKey') as string) || ''
          const model = (await window.electronAPI.config.get('agentModel') as string) || 'gpt-4o'
          return { apiUrl, apiKey, model }
        } catch (_) {
          return { apiUrl: 'https://api.openai.com', apiKey: '', model: 'gpt-4o' }
        }
      }

      // 使用 LLM 智能分析
      const analysisResult = await analyzeSpecialDaysWithLLM(
        sortedMessages,
        contactDisplayName,
        args.analysisType || 'comprehensive',
        getConfig,
        (current, total, message) => {
          onProgress?.(current, total, message)
        }
      )

      // 构建详细的结果说明
      const senderExplanation = `
【发送者说明 - 极其重要】
- "我" = 当前用户（你自己，即 ChatFlow 的使用者）
- "对方" = ${contactDisplayName}
- 生日祝福由"我"发送 = 你祝福对方的生日 → ${contactDisplayName}的生日
- 生日祝福由"对方"发送 = ${contactDisplayName}祝福你的生日 → 你的生日

【特殊日子类型说明】
- birthday: 生日相关
- holiday: 节日庆祝
- relationship: 关系进展
- anniversary: 纪念日
- first_contact: 首次联系/相识
      `.trim()

      // 构建 LLM 分析指导（供 AI 进一步分析）
      const llmAnalysisGuidance = `
你作为 LLaM，请基于以下 LLM 智能分析结果，向用户提供专业的关系洞察：

【LLM 智能分析结果】
${analysisResult.llmAnalysis.userBirthday?.date !== '未找到' ? `
**你的生日**：${analysisResult.llmAnalysis.userBirthday?.date || '未找到'}
- 置信度：${((analysisResult.llmAnalysis.userBirthday?.confidence || 0) * 100).toFixed(0)}%
- 日历类型：${analysisResult.llmAnalysis.userBirthday?.calendarType === 'lunar' ? '农历' : '公历'}
- 消息来源：${analysisResult.llmAnalysis.userBirthday?.sourceMessages?.join('；') || '无'}
- 备注：${analysisResult.llmAnalysis.userBirthday?.notes || '无'}
` : '**你的生日**：未在聊天记录中找到明确信息'}

${analysisResult.llmAnalysis.contactBirthday?.date !== '未找到' ? `
**${contactDisplayName}的生日**：${analysisResult.llmAnalysis.contactBirthday?.date || '未找到'}
- 置信度：${((analysisResult.llmAnalysis.contactBirthday?.confidence || 0) * 100).toFixed(0)}%
- 日历类型：${analysisResult.llmAnalysis.contactBirthday?.calendarType === 'lunar' ? '农历' : '公历'}
- 消息来源：${analysisResult.llmAnalysis.contactBirthday?.sourceMessages?.join('；') || '无'}
- 备注：${analysisResult.llmAnalysis.contactBirthday?.notes || '无'}
` : `**${contactDisplayName}的生日**：未在聊天记录中找到明确信息`}

**检测到的节日**：
${analysisResult.llmAnalysis.holidays?.length > 0
  ? analysisResult.llmAnalysis.holidays.map((h: any) => `- ${h.name} (${h.date}) - ${h.sender}发送`).join('\n')
  : '无'}

**关系进展**：
${analysisResult.llmAnalysis.relationships?.length > 0
  ? analysisResult.llmAnalysis.relationships.map((r: any) => `- ${r.description} (${r.date}) - ${r.sender}发送`).join('\n')
  : '未检测到明确的关系进展标记'}

**分析摘要**：${analysisResult.summary.llmSummary || 'LLM 未能提供详细摘要'}

【重要提示】
- 生日信息基于聊天记录中的祝福和提及，农历日期需要用户确认具体公历日期
- 祝福消息的日期可能不是生日当天，建议结合日期和祝福内容综合判断
- 如需更精确的分析，请提供更多上下文或让用户手动确认生日信息
      `.trim()

      // 按类型过滤
      let filteredSpecialDays = analysisResult.specialDays
      if (args.analysisType === 'birthday_only') {
        filteredSpecialDays = analysisResult.specialDays.filter((d: any) => d.type === 'birthday')
      } else if (args.analysisType === 'holidays_only') {
        filteredSpecialDays = analysisResult.specialDays.filter((d: any) => d.type === 'holiday')
      } else if (args.analysisType === 'anniversary_only') {
        filteredSpecialDays = analysisResult.specialDays.filter((d: any) => ['relationship', 'anniversary', 'first_contact'].includes(d.type))
      }

      return {
        contactName: contactDisplayName,
        contactUsername: contact.username,
        totalMessages: sortedMessages.length,
        specialDays: filteredSpecialDays,
        allSpecialDays: analysisResult.specialDays,
        senderExplanation,
        llmAnalysis: analysisResult.llmAnalysis,
        summary: analysisResult.summary,
        llmAnalysisGuidance: llmAnalysisGuidance
      }
    }, { timeout: 120000 }) // 120秒超时（LLM分析可能需要更长时间）
  }
}

// 工具 10: 聊天风格画像
const chatStyleProfileTool: AgentTool = {
  name: 'chat_style_profile',
  description:
    '分析用户在所有对话中的用词习惯、表情偏好、回复速度、活跃时段，生成个人聊天风格画像。基于全量统计数据。适用于：自我了解、趣味分析。',
  parameters: {
    analysisType: {
      type: 'string',
      description: '分析类型：overall(整体)/contact(指定联系人)',
      required: false,
      enum: ['overall', 'contact']
    },
    contactName: {
      type: 'string',
      description: '指定联系人时使用',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('chat_style_profile', args, async (args, onProgress) => {
      const overallStatsResult = await window.electronAPI.analytics.getOverallStatistics()
      const timeDistResult = await window.electronAPI.analytics.getTimeDistribution()
      const rankingsResult = await window.electronAPI.analytics.getContactRankings(10)

      const overallStats = overallStatsResult?.data || {}
      const timeDist = timeDistResult?.data || {}
      const rankings = rankingsResult?.data || []

      let contactStats = null
      if (args.analysisType === 'contact' && args.contactName) {
        const contactsResult = await window.electronAPI.chat.getContacts({ lite: true })

        if (contactsResult?.success) {
          const contacts = Array.isArray(contactsResult.contacts) ? contactsResult.contacts : []
          const { contact } = findContact(contacts, args.contactName)

          if (contact) {
            const statsResult = await window.electronAPI.chat.getExportSessionStats(
              [contact.username],
              {}
            )
            contactStats = statsResult?.data?.[contact.username] || {}
          }
        }
      }

      return {
        overall: overallStats,
        timeDistribution: timeDist,
        topContacts: rankings,
        contactStats
      }
    })
  }
}

// 工具 11: 关系健康度评估
const relationshipHealthTool: AgentTool = {
  name: 'relationship_health',
  description:
    '综合分析与指定联系人的关系健康度，从沟通频率、回复质量、参与度平衡、情感基调、一致性五个维度进行评估。分析最近2000条消息。适用于：了解关系状态、发现潜在问题、改善沟通质量。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    timeRange: {
      type: 'string',
      description: '时间范围，默认 this_month',
      required: false,
      enum: ['this_week', 'this_month', 'this_year', 'all']
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('relationship_health', args, async (args, onProgress) => {
      const timeRange = args.timeRange || 'this_month'

      // 1. 获取联系人列表
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      // 2. 计算时间范围
      let startTime = 0
      let daysInRange = 30
      const now = new Date()
      const endTime = now.getTime() / 1000

      switch (timeRange) {
        case 'this_week':
          startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000
          daysInRange = 7
          break
        case 'this_month':
          startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
          daysInRange = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
          break
        case 'this_year':
          startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000
          daysInRange = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000)
          break
        case 'all':
          startTime = 0
          daysInRange = 365
          break
      }

      // 3. 获取数据
      const [messagesResult, dateCountsResult, statsResult] = await Promise.all([
        window.electronAPI.chat.getMessages(contact.username, 0, 2000, startTime, endTime),
        window.electronAPI.chat.getMessageDateCounts(contact.username),
        window.electronAPI.chat.getExportSessionStats([contact.username], {})
      ])

      const messages = messagesResult?.messages || []
      const dateCounts = dateCountsResult?.counts || {}
      const sessionStats = statsResult?.data?.[contact.username] || {}

      if (!messages || messages.length === 0) {
        throw new Error(
          `该时间段内没有与"${contact.remark || contact.nickname || contact.username}"的聊天记录`
        )
      }

      // 4. 分析维度数据

      // 4.1 沟通频率分析
      const totalMessages = messages.length

      // 计算实际活跃天数（基于dateCounts中在时间范围内的日期）
      const filteredDateCounts: Record<string, number> = {}
      Object.entries(dateCounts).forEach(([date, count]) => {
        const dateTime = new Date(date).getTime() / 1000
        if (dateTime >= startTime && dateTime <= endTime) {
          filteredDateCounts[date] = count as number
        }
      })
      const activeDays = Object.values(filteredDateCounts).filter(c => c > 0).length
      // 使用实际活跃天数计算日均消息数，如果没有活跃天数则回退到daysInRange
      const messagesPerDay = activeDays > 0 ? totalMessages / activeDays : totalMessages / daysInRange

      // 计算趋势（比较前半段和后半段）
      const midPoint = Math.floor(messages.length / 2)
      const firstHalfCount = midPoint
      const secondHalfCount = messages.length - midPoint
      let frequencyTrend = 'stable'
      if (secondHalfCount > firstHalfCount * 1.3) {
        frequencyTrend = 'increasing'
      } else if (secondHalfCount < firstHalfCount * 0.7) {
        frequencyTrend = 'decreasing'
      }

      // 频率评分 (0-100)
      let frequencyScore = Math.min(100, Math.round(messagesPerDay * 10))
      if (frequencyScore < 20) frequencyScore = 20

      // 4.2 回复质量分析
      const textMessages = messages.filter((m: any) => m.localType === 1)
      const totalLength = textMessages.reduce((sum: number, m: any) => {
        const content = m.parsedContent || m.content || ''
        return sum + content.length
      }, 0)
      const avgMessageLength = textMessages.length > 0 ? totalLength / textMessages.length : 0

      // 计算回复比例（有来有回）
      const myMessages = messages.filter((m: any) => m.isSend).length
      const theirMessages = messages.filter((m: any) => !m.isSend).length
      const totalExchanges = Math.min(myMessages, theirMessages)
      const replyRatio = totalMessages > 0 ? (totalExchanges * 2) / totalMessages : 0

      // 质量评分
      let qualityScore = Math.min(100, Math.round(avgMessageLength * 2 + replyRatio * 50))
      if (qualityScore < 30) qualityScore = 30
      if (qualityScore > 100) qualityScore = 100

      // 4.3 参与度平衡分析
      const myRatio = totalMessages > 0 ? myMessages / totalMessages : 0.5
      const theirRatio = totalMessages > 0 ? theirMessages / totalMessages : 0.5
      const balanceScore = Math.round(100 - Math.abs(myRatio - theirRatio) * 100)

      let initiator = 'balanced'
      if (myRatio > theirRatio + 0.2) {
        initiator = 'me'
      } else if (theirRatio > myRatio + 0.2) {
        initiator = 'them'
      }

      // 4.4 情感基调分析
      const positiveKeywords = [
        '开心', '高兴', '喜欢', '爱', '棒', '好', '优秀', '赞', '哈哈', '嘿嘿', '嘻嘻',
        '谢谢', '感谢', '感激', '温暖', '幸福', '快乐', '愉快', '舒服', '满意', '期待',
        '想念', '想你了', '抱抱', '亲亲', '爱你', '亲爱的', '宝贝', '可爱', '漂亮',
        '好的', '没问题', '可以', '行', '好的呀', '好哒', '嗯嗯', '好呢'
      ]
      const negativeKeywords = [
        '生气', '难过', '伤心', '失望', '讨厌', '烦', '累', '压力大', '焦虑', '担心',
        '害怕', '恐惧', '痛苦', '糟糕', '不好', '差', '烂', '垃圾', '无语', '郁闷',
        '愤怒', '恨', '拒绝', '不要', '不行', '不可以', '算了', '随便', '无所谓',
        '忙', '没空', '没时间', '别烦我', '走开', '闭嘴', '滚'
      ]

      let positiveCount = 0
      let negativeCount = 0

      for (const m of messages) {
        if (m.localType !== 1) continue
        const content = (m.parsedContent || m.content || '').toLowerCase()
        for (const word of positiveKeywords) {
          if (content.includes(word)) positiveCount++
        }
        for (const word of negativeKeywords) {
          if (content.includes(word)) negativeCount++
        }
      }

      const totalSentiment = positiveCount + negativeCount
      const sentimentRatio = totalSentiment > 0 ? positiveCount / totalSentiment : 0.5

      let sentiment = 'neutral'
      if (sentimentRatio > 0.7) sentiment = 'very_positive'
      else if (sentimentRatio > 0.55) sentiment = 'positive'
      else if (sentimentRatio < 0.3) sentiment = 'negative'
      else if (sentimentRatio < 0.45) sentiment = 'slightly_negative'

      const emotionalScore = Math.round(sentimentRatio * 100)

      // 4.5 一致性分析
      // 计算每日消息数的标准差（使用前面已经计算好的filteredDateCounts和activeDays）
      const dailyCounts = Object.values(filteredDateCounts)
      const avgDaily = dailyCounts.length > 0 ? dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length : 0

      // 计算方差
      const variance = dailyCounts.length > 0
        ? dailyCounts.reduce((sum, count) => sum + Math.pow(count - avgDaily, 2), 0) / dailyCounts.length
        : 0
      const stdDev = Math.sqrt(variance)
      const coefficientOfVariation = avgDaily > 0 ? stdDev / avgDaily : 0

      // 一致性评分（变异系数越低，一致性越高）
      let consistencyScore = Math.round(100 - Math.min(100, coefficientOfVariation * 50))
      if (consistencyScore < 20) consistencyScore = 20

      // 5. 计算总体健康度评分
      const weights = {
        communicationFrequency: 0.25,
        responseQuality: 0.25,
        engagementBalance: 0.2,
        emotionalTone: 0.15,
        consistency: 0.15
      }

      const overallScore = Math.round(
        frequencyScore * weights.communicationFrequency +
        qualityScore * weights.responseQuality +
        balanceScore * weights.engagementBalance +
        emotionalScore * weights.emotionalTone +
        consistencyScore * weights.consistency
      )

      // 6. 确定健康等级
      let healthLevel: 'excellent' | 'good' | 'moderate' | 'needs_attention' | 'concerning'
      if (overallScore >= 85) healthLevel = 'excellent'
      else if (overallScore >= 70) healthLevel = 'good'
      else if (overallScore >= 55) healthLevel = 'moderate'
      else if (overallScore >= 40) healthLevel = 'needs_attention'
      else healthLevel = 'concerning'

      // 7. 生成总结和建议
      const summaries: Record<string, string> = {
        excellent: `与${contact.remark || contact.nickname || contact.username}的关系非常健康，各方面表现都很出色。`,
        good: `与${contact.remark || contact.nickname || contact.username}的关系整体良好，大部分维度表现不错。`,
        moderate: `与${contact.remark || contact.nickname || contact.username}的关系处于中等水平，有改善空间。`,
        needs_attention: `与${contact.remark || contact.nickname || contact.username}的关系需要关注，建议采取行动改善。`,
        concerning: `与${contact.remark || contact.nickname || contact.username}的关系令人担忧，建议认真思考并采取行动。`
      }

      const recommendations: string[] = []

      if (frequencyScore < 50) {
        recommendations.push('沟通频率较低，建议主动联系对方，保持定期交流')
      }
      if (qualityScore < 50) {
        recommendations.push('对话深度不够，可以尝试分享更多想法和感受，增加有意义的交流')
      }
      if (balanceScore < 50) {
        if (initiator === 'me') {
          recommendations.push('你主动较多，可以适当给对方一些空间，或引导对方更主动参与')
        } else if (initiator === 'them') {
          recommendations.push('对方主动较多，建议你也更积极地发起对话，保持双向互动')
        }
      }
      if (emotionalScore < 50) {
        recommendations.push('情感基调偏消极，建议多表达积极情绪，关注对方的感受')
      }
      if (consistencyScore < 50) {
        recommendations.push('沟通规律性不足，建议建立更稳定的联系节奏')
      }

      if (recommendations.length === 0) {
        recommendations.push('关系状态良好，继续保持当前的沟通方式')
        if (overallScore >= 80) {
          recommendations.push('可以尝试更多共同活动或深入话题，进一步加深关系')
        }
      }

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        timeRange,
        overallScore,
        healthLevel,
        dimensions: {
          communicationFrequency: {
            score: frequencyScore,
            trend: frequencyTrend,
            details: `在 ${activeDays} 个活跃日中，平均每天 ${messagesPerDay.toFixed(1)} 条消息，${frequencyTrend === 'increasing' ? '呈上升趋势' : frequencyTrend === 'decreasing' ? '呈下降趋势' : '保持稳定'}`
          },
          responseQuality: {
            score: qualityScore,
            details: `平均消息长度 ${avgMessageLength.toFixed(0)} 字，回复比例 ${(replyRatio * 100).toFixed(0)}%`
          },
          engagementBalance: {
            score: balanceScore,
            initiator,
            details: `你发送 ${myMessages} 条，对方发送 ${theirMessages} 条，${initiator === 'balanced' ? '参与度均衡' : initiator === 'me' ? '你更主动' : '对方更主动'}`
          },
          emotionalTone: {
            score: emotionalScore,
            sentiment,
            details: `积极情绪 ${positiveCount} 次，消极情绪 ${negativeCount} 次，整体${sentiment === 'very_positive' ? '非常积极' : sentiment === 'positive' ? '积极' : sentiment === 'neutral' ? '中性' : sentiment === 'slightly_negative' ? '略偏消极' : '消极'}`
          },
          consistency: {
            score: consistencyScore,
            details: `活跃天数 ${activeDays} 天，沟通规律性${consistencyScore >= 70 ? '良好' : consistencyScore >= 50 ? '一般' : '较差'}`
          }
        },
        summary: summaries[healthLevel],
        recommendations,
        statistics: {
          totalMessages,
          messagesPerDay: parseFloat(messagesPerDay.toFixed(2)),
          activeDays,
          myMessages,
          theirMessages,
          avgMessageLength: parseFloat(avgMessageLength.toFixed(1))
        }
      }
    })
  }
}

// 工具 12: 消息分类标记
const messageClassificationTool: AgentTool = {
  name: 'message_classification',
  description:
    '自动扫描聊天记录，标记重要消息类型（约定、金额、日期、地址、承诺等）。默认扫描最近100条消息，建议指定timeRange缩小范围。适用于：快速找到重要信息。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    timeRange: {
      type: 'string',
      description: '时间范围，默认 this_month',
      required: false,
      enum: ['today', 'this_week', 'this_month', 'this_year']
    },
    limit: {
      type: 'number',
      description: '扫描消息条数，默认100',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('message_classification', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      let startTime = 0
      const now = new Date()
      const timeRange = args.timeRange || 'this_month'
      switch (timeRange) {
        case 'today':
          startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
          break
        case 'this_week':
          startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000
          break
        case 'this_month':
          startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
          break
        case 'this_year':
          startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000
          break
      }

      const messagesResult = await window.electronAPI.chat.getMessages(
        contact.username,
        0,
        args.limit || 100,
        startTime,
        Date.now() / 1000
      )

      const messages = messagesResult?.messages || []

      if (!messages || messages.length === 0) {
        throw new Error(
          `该时间段内没有与"${contact.remark || contact.nickname || contact.username}"的聊天记录`
        )
      }

      // 过滤文本消息和可解析的转发消息（localType === 1 或 localType === 49）
      const textMessages = messages.filter((m: any) => {
        if (m.localType === 1) {
          return (m.parsedContent || m.content) && String(m.parsedContent || m.content).length > 5
        } else if (m.localType === 49) {
          const forwardedContent = extractForwardedContent(m)
          return forwardedContent && forwardedContent.length > 5
        }
        return false
      })

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        totalScanned: messages.length,
        textMessages: textMessages.slice(0, 50).map((m: any) => {
          let content = ''
          let isForwarded = false

          if (m.localType === 1) {
            content = m.parsedContent || m.content || ''
          } else if (m.localType === 49) {
            content = extractForwardedContent(m)
            isForwarded = true
          }

          return {
            content: content.slice(0, 300),
            time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : '',
            sender: m.isSend ? '我' : '对方',
            messageType: isForwarded ? 'forwarded' : 'text'
          }
        })
      }
    })
  }
}

// 工具 11: 承诺追踪器
const promiseTrackerTool: AgentTool = {
  name: 'promise_tracker',
  description:
    '追踪聊天记录中的承诺、约定、保证和计划。默认扫描最近200条消息，建议指定timeRange缩小范围。适用于：查找谁答应了你什么、跟踪待办事项、回顾约定内容。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称',
      required: true
    },
    timeRange: {
      type: 'string',
      description: '时间范围，默认 this_month',
      required: false,
      enum: ['today', 'this_week', 'this_month', 'this_year']
    },
    limit: {
      type: 'number',
      description: '扫描消息条数，默认200',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('promise_tracker', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      let startTime = 0
      const now = new Date()
      const timeRange = args.timeRange || 'this_month'
      switch (timeRange) {
        case 'today':
          startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
          break
        case 'this_week':
          startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000
          break
        case 'this_month':
          startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
          break
        case 'this_year':
          startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000
          break
      }

      const messagesResult = await window.electronAPI.chat.getMessages(
        contact.username,
        0,
        args.limit || 200,
        startTime,
        Date.now() / 1000
      )

      const messages = messagesResult?.messages || []

      if (!messages || messages.length === 0) {
        throw new Error(
          `该时间段内没有与"${contact.remark || contact.nickname || contact.username}"的聊天记录`
        )
      }

      // 承诺相关关键词模式
      const promisePatterns = [
        // 承诺类
        { pattern: /答应|承诺|保证|许诺|应允|应承/, type: 'promise', weight: 3 },
        // 约定类
        { pattern: /约好了?|约定|约好|说好了?|定好了?/, type: 'agreement', weight: 3 },
        // 时间承诺
        { pattern: /到时候|改天|下次|回头|有空|有时间|过几天|过段时间/, type: 'future_plan', weight: 2 },
        // 肯定承诺
        { pattern: /一定|肯定|绝对|必须|没问题|放心|包在我身上/, type: 'commitment', weight: 2 },
        // 行动承诺
        { pattern: /帮你|给你|给你做|给你带|帮你办|帮你处理|帮你搞定/, type: 'action', weight: 2 },
        // 完成承诺
        { pattern: /做完|弄完|搞定|完成|办好|处理好/, type: 'completion', weight: 2 },
        // 金钱承诺
        { pattern: /还你|给你钱|借你|转账|打钱|付款|报销/, type: 'financial', weight: 2 },
        // 见面承诺
        { pattern: /请你吃饭|请你喝|请你玩|找你|来找你|去看你/, type: 'social', weight: 2 }
      ]

      // 完成/取消标记词
      const completionMarkers = [
        { pattern: /已经|早就|完成了|搞定了|弄好了|做完了/, status: 'completed' },
        { pattern: /谢谢|感谢|收到了|拿到了|看到了/, status: 'completed' },
        { pattern: /取消|算了|不用了|别了|改天再说/, status: 'cancelled' },
        { pattern: /抱歉|对不起|忘了|没空|没时间/, status: 'failed' }
      ]

      // 提取消息内容
      const extractContent = (m: any): string => {
        if (m.localType === 1) {
          return m.parsedContent || m.content || ''
        } else if (m.localType === 49) {
          return extractForwardedContent(m) || ''
        }
        return ''
      }

      // 分析承诺
      const promises: any[] = []
      const analyzedContents = new Set<string>()

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        const content = extractContent(m)

        if (!content || content.length < 3 || analyzedContents.has(content)) {
          continue
        }
        analyzedContents.add(content)

        // 检查是否包含承诺关键词
        let maxWeight = 0
        let matchedTypes: string[] = []

        for (const p of promisePatterns) {
          if (p.pattern.test(content)) {
            maxWeight = Math.max(maxWeight, p.weight)
            if (!matchedTypes.includes(p.type)) {
              matchedTypes.push(p.type)
            }
          }
        }

        // 权重达到阈值才认为是承诺
        if (maxWeight >= 2) {
          // 查找后续消息判断状态
          let status = 'pending'
          const contextMessages: string[] = []

          // 收集上下文（前后各2条消息）
          for (let j = Math.max(0, i - 2); j <= Math.min(messages.length - 1, i + 2); j++) {
            if (j !== i) {
              const ctxContent = extractContent(messages[j])
              if (ctxContent) {
                const sender = messages[j].isSend ? '我' : '对方'
                contextMessages.push(`${sender}: ${ctxContent.slice(0, 100)}`)
              }
            }
          }

          // 检查后续消息是否有完成标记
          for (let j = i + 1; j < Math.min(messages.length, i + 10); j++) {
            const laterContent = extractContent(messages[j])
            if (!laterContent) continue

            for (const marker of completionMarkers) {
              if (marker.pattern.test(laterContent)) {
                status = marker.status
                break
              }
            }
            if (status !== 'pending') break
          }

          // 判断承诺方
          const promisor = m.isSend ? '我' : '对方'
          const promisee = m.isSend ? '对方' : '我'

          promises.push({
            content: content.slice(0, 200),
            date: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : '',
            timestamp: m.createTime || 0,
            promisor,
            promisee,
            types: matchedTypes,
            status,
            weight: maxWeight,
            context: contextMessages.slice(0, 4)
          })
        }
      }

      // 按权重和时间排序
      promises.sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight
        return b.timestamp - a.timestamp
      })

      // 统计
      const stats = {
        total: promises.length,
        pending: promises.filter(p => p.status === 'pending').length,
        completed: promises.filter(p => p.status === 'completed').length,
        cancelled: promises.filter(p => p.status === 'cancelled').length,
        failed: promises.filter(p => p.status === 'failed').length
      }

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        totalScanned: messages.length,
        stats,
        promises: promises.slice(0, 20).map(p => ({
          content: p.content,
          date: p.date,
          promisor: p.promisor,
          promisee: p.promisee,
          types: p.types,
          status: p.status,
          context: p.context
        }))
      }
    })
  }
}

// 工具 12: 获取所有联系人列表
const listAllContactsTool: AgentTool = {
  name: 'list_all_contacts',
  description: '获取所有联系人列表。适用于：查看有哪些联系人可用、选择要分析的联系人。',
  parameters: {
    limit: {
      type: 'number',
      description: '返回的最大联系人数量，默认50',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('list_all_contacts', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 过滤掉已删除好友（只保留当前有效的联系人）
      const activeContacts = contacts.filter((c: any) => c.type !== 'former_friend')

      if (activeContacts.length === 0) {
        throw new Error('没有有效的联系人')
      }

      const limit = args.limit || 50

      return {
        totalContacts: activeContacts.length,
        contacts: activeContacts.slice(0, limit).map((c: any) => ({
          nickname: c.nickname || '',
          remark: c.remark || '',
          username: c.username || ''
        }))
      }
    })
  }
}

// 工具 13: 获取联系人地区信息
const getContactRegionTool: AgentTool = {
  name: 'get_contact_region',
  description:
    '获取指定联系人的国家、省份、城市等地理位置信息。适用于：查询某某好友是哪里人、了解联系人的地区信息。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称（昵称或备注）',
      required: true
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_contact_region', args, async (args, onProgress) => {
      // 获取联系人列表（使用full模式以获取地区信息）
      const result = await window.electronAPI.chat.getContacts({ lite: false })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 查找联系人
      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      // 解析地区信息
      const regionText = contact.region || ''
      const regionParts = regionText.split(/\s+/).filter(Boolean)

      // 根据字段数量解析国家、省份、城市
      let country = ''
      let province = ''
      let city = ''

      if (regionParts.length >= 3) {
        // 有国家信息（如：日本 冲绳县 冲绳群岛）
        country = regionParts[0]
        province = regionParts[1]
        city = regionParts[2]
      } else if (regionParts.length === 2) {
        // 只有省份和城市（如：四川 成都）
        country = '中国'
        province = regionParts[0]
        city = regionParts[1]
      } else if (regionParts.length === 1) {
        // 只有一项，可能是省份或国家
        country = regionParts[0]
      }

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        username: contact.username,
        region: {
          full: regionText || '未知',
          country: country || '未知',
          province: province || '未知',
          city: city || '未知'
        },
        hasRegionInfo: Boolean(regionText)
      }
    })
  }
}

// 工具 13.5: 获取自己的地区信息
const getMyRegionTool: AgentTool = {
  name: 'get_my_region',
  description:
    '获取当前用户（你自己）的国家、省份、城市等地理位置信息。适用于：查询自己所在地区、获取自己的城市天气等。',
  parameters: {},
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_my_region', args, async (args, onProgress) => {
      // 获取当前用户信息（包含地区）
      const result = await window.electronAPI.chat.getMyInfo()

      if (!result || !result.success) {
        throw new Error(`获取当前用户信息失败：${result?.error || '未知错误'}`)
      }

      // 解析地区信息
      const regionText = result.region || ''
      const regionParts = regionText.split(/\s+/).filter(Boolean)

      // 根据字段数量解析国家、省份、城市
      let country = ''
      let province = ''
      let city = ''

      if (regionParts.length >= 3) {
        country = regionParts[0]
        province = regionParts[1]
        city = regionParts[2]
      } else if (regionParts.length === 2) {
        country = '中国'
        province = regionParts[0]
        city = regionParts[1]
      } else if (regionParts.length === 1) {
        country = regionParts[0]
      }

      return {
        username: result.username,
        displayName: result.displayName || result.username,
        region: {
          full: regionText || '未知',
          country: country || '未知',
          province: province || '未知',
          city: city || '未知'
        },
        hasRegionInfo: Boolean(regionText)
      }
    })
  }
}

// 工具 13.6: 获取自己所在城市的天气
const getMyWeatherTool: AgentTool = {
  name: 'get_my_weather',
  description:
    '获取当前用户（你自己）所在城市的当前天气信息。适用于：查询自己所在城市的天气、了解自己那边的气温和天气状况。',
  parameters: {
    format: {
      type: 'string',
      description: '输出格式：simple(简洁格式，仅温度和天气) 或 detailed(详细格式，包含风速、湿度等)',
      required: false,
      enum: ['simple', 'detailed']
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_my_weather', args, async (args, onProgress) => {
      const format = args.format || 'simple'

      // 先获取当前用户信息（包含地区）
      const result = await window.electronAPI.chat.getMyInfo()

      if (!result || !result.success) {
        throw new Error(`获取当前用户信息失败：${result?.error || '未知错误'}`)
      }

      // 解析地区信息获取城市
      const regionText = result.region || ''
      const regionParts = regionText.split(/\s+/).filter(Boolean)

      let city = ''
      if (regionParts.length >= 3) {
        city = regionParts[2]
      } else if (regionParts.length === 2) {
        city = regionParts[1]
      } else if (regionParts.length === 1) {
        city = regionParts[0]
      }

      if (!city) {
        throw new Error(`你还没有设置地区信息，无法查询天气。请在微信中设置你的地区，或直接告诉我你所在的城市名称。`)
      }

      // 构建 wttr.in API URL
      const formatParam = format === 'detailed'
        ? '%l:+%t+%C+%w+%h'
        : '%l:+%t+%C'

      const url = `https://wttr.in/${encodeURIComponent(city)}?format=${encodeURIComponent(formatParam)}&lang=zh`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'curl/7.68.0'
          }
        })

        if (!response.ok) {
          throw new Error(`获取天气失败：HTTP ${response.status}`)
        }

        const weatherText = await response.text()

        if (weatherText.includes('Unknown location') || weatherText.includes('Not Found')) {
          throw new Error(`未找到城市"${city}"的天气信息，请检查地区设置是否正确`)
        }

        return {
          city: city,
          fullRegion: regionText,
          weather: weatherText.trim(),
          format: format,
          source: 'wttr.in'
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error
        }
        throw new Error(`获取天气信息失败：${String(error)}`)
      }
    })
  }
}

// 工具 14: 分析联系人地区分布
const analyzeContactsRegionDistributionTool: AgentTool = {
  name: 'analyze_contacts_region_distribution',
  description:
    '分析所有好友或指定群聊的成员地区分布情况。适用于：统计所有好友的地区分布、分析某个群的好友都来自哪些地方、了解好友的地域构成。',
  parameters: {
    scope: {
      type: 'string',
      description: '分析范围：all_friends(所有好友) 或 group(指定群聊)',
      required: true,
      enum: ['all_friends', 'group']
    },
    groupName: {
      type: 'string',
      description: '群聊名称（scope为group时必填）',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('analyze_contacts_region_distribution', args, async (args, onProgress) => {
      // 获取所有联系人（使用full模式以获取地区信息）
      const contactsResult = await window.electronAPI.chat.getContacts({ lite: false })

      if (!contactsResult || !contactsResult.success) {
        throw new Error(`获取联系人列表失败：${contactsResult?.error || '未知错误'}`)
      }

      const allContacts = Array.isArray(contactsResult.contacts) ? contactsResult.contacts : []

      if (allContacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 只保留有地区信息的好友
      const contactsWithRegion = allContacts.filter((c: any) => c.region && c.region.trim())

      if (contactsWithRegion.length === 0) {
        throw new Error('没有找到有地区信息的联系人')
      }

      let targetContacts = contactsWithRegion
      let targetName = '所有好友'

      // 如果指定了群聊，获取群成员并筛选
      if (args.scope === 'group') {
        if (!args.groupName) {
          throw new Error('分析群聊地区分布时，必须提供groupName参数')
        }

        // 获取群聊列表
        const groupsResult = await window.electronAPI.groupAnalytics.getGroupChats()
        const groups = groupsResult?.data || []

        // 查找群聊
        const searchName = args.groupName.toLowerCase()
        const group =
          groups.find(
            (g: any) => g.displayName?.toLowerCase() === searchName || g.username === args.groupName
          ) || groups.find((g: any) => g.displayName?.toLowerCase().includes(searchName))

        if (!group) {
          const similarGroups = groups
            .filter((g: any) => g.displayName?.toLowerCase().includes(searchName))
            .slice(0, 5)
            .map((g: any) => g.displayName)

          const error: any = new Error(`未找到群聊"${args.groupName}"`)
          error.suggestions = similarGroups.length > 0 ? similarGroups : undefined
          throw error
        }

        targetName = group.displayName || args.groupName

        // 获取群成员列表
        const membersResult = await window.electronAPI.groupAnalytics.getGroupMembers(group.username)
        const members = membersResult?.data || []

        if (members.length === 0) {
          throw new Error(`群聊"${targetName}"没有成员信息`)
        }

        // 提取成员用户名集合
        const memberUsernames = new Set(members.map((m: any) => m.username).filter(Boolean))

        // 筛选出群成员中的联系人
        targetContacts = contactsWithRegion.filter((c: any) => memberUsernames.has(c.username))

        if (targetContacts.length === 0) {
          throw new Error(`群聊"${targetName}"的成员中没有找到有地区信息的联系人`)
        }
      }

      // 统计地区分布
      const countryStats: Record<string, number> = {}
      const provinceStats: Record<string, number> = {}
      const cityStats: Record<string, number> = {}

      // 记录每个地区的联系人列表（用于详情展示）
      const countryContacts: Record<string, string[]> = {}
      const provinceContacts: Record<string, string[]> = {}

      for (const contact of targetContacts) {
        const regionText = contact.region || ''
        const regionParts = regionText.split(/\s+/).filter(Boolean)
        const displayName = contact.remark || contact.nickname || contact.username

        let country = '未知'
        let province = '未知'
        let city = '未知'

        if (regionParts.length >= 3) {
          country = regionParts[0]
          province = regionParts[1]
          city = regionParts[2]
        } else if (regionParts.length === 2) {
          country = '中国'
          province = regionParts[0]
          city = regionParts[1]
        } else if (regionParts.length === 1) {
          country = regionParts[0]
          province = regionParts[0]
        }

        // 统计国家
        countryStats[country] = (countryStats[country] || 0) + 1
        if (!countryContacts[country]) countryContacts[country] = []
        countryContacts[country].push(displayName)

        // 统计省份（只统计中国的省份）
        if (country === '中国' && province !== '未知') {
          provinceStats[province] = (provinceStats[province] || 0) + 1
          if (!provinceContacts[province]) provinceContacts[province] = []
          provinceContacts[province].push(displayName)
        }

        // 统计城市
        if (city !== '未知') {
          cityStats[city] = (cityStats[city] || 0) + 1
        }
      }

      // 转换为排序后的数组格式
      const sortedCountries = Object.entries(countryStats)
        .map(([name, count]) => ({
          name,
          count,
          percentage: Math.round((count / targetContacts.length) * 100),
          contacts: countryContacts[name]?.slice(0, 10) || [] // 最多显示10个联系人
        }))
        .sort((a, b) => b.count - a.count)

      const sortedProvinces = Object.entries(provinceStats)
        .map(([name, count]) => ({
          name,
          count,
          percentage: Math.round((count / targetContacts.length) * 100),
          contacts: provinceContacts[name]?.slice(0, 10) || []
        }))
        .sort((a, b) => b.count - a.count)

      const sortedCities = Object.entries(cityStats)
        .map(([name, count]) => ({ name, count, percentage: Math.round((count / targetContacts.length) * 100) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20) // 城市只显示前20

      return {
        scope: args.scope,
        targetName,
        totalAnalyzed: targetContacts.length,
        totalWithRegion: contactsWithRegion.length,
        coverageRate: Math.round((targetContacts.length / (args.scope === 'group' ? targetContacts.length : contactsWithRegion.length)) * 100),
        distribution: {
          byCountry: sortedCountries,
          byProvince: sortedProvinces,
          byCity: sortedCities.slice(0, 10) // 城市只显示前10
        },
        summary: {
          topCountry: sortedCountries[0]?.name || '未知',
          topProvince: sortedProvinces[0]?.name || '未知',
          topCity: sortedCities[0]?.name || '未知',
          abroadCount: sortedCountries.filter((c: any) => c.name !== '中国').reduce((sum: number, c: any) => sum + c.count, 0)
        }
      }
    })
  }
}

// 工具 15: 获取联系人个性签名
const getContactSignatureTool: AgentTool = {
  name: 'get_contact_signature',
  description:
    '获取指定联系人的个性签名。适用于：查看某某好友的个性签名、了解联系人的个人简介或心情状态。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称（昵称或备注）',
      required: true
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_contact_signature', args, async (args, onProgress) => {
      // 获取联系人列表（使用full模式以获取个性签名）
      const result = await window.electronAPI.chat.getContacts({ lite: false })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 查找联系人
      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      // 获取个性签名
      const signature = contact.detailDescription || ''

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        username: contact.username,
        signature: signature || '该联系人没有设置个性签名',
        hasSignature: Boolean(signature && signature.trim()),
        signatureLength: signature ? signature.length : 0
      }
    })
  }
}

// 工具 16: 获取所有群聊列表
const listAllGroupsTool: AgentTool = {
  name: 'list_all_groups',
  description: '获取所有群聊列表。适用于：查看有哪些群聊可用、选择要分析的群聊。',
  parameters: {
    limit: {
      type: 'number',
      description: '返回的最大群聊数量，默认50',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('list_all_groups', args, async (args, onProgress) => {
      const result = await window.electronAPI.groupAnalytics.getGroupChats()

      if (!result || !result.success) {
        throw new Error(`获取群聊列表失败：${result?.error || '未知错误'}`)
      }

      const groups = Array.isArray(result.data) ? result.data : []

      if (groups.length === 0) {
        throw new Error('群聊列表为空')
      }

      const limit = args.limit || 50

      return {
        totalGroups: groups.length,
        groups: groups.slice(0, limit).map((g: any) => ({
          displayName: g.displayName || '',
          username: g.username || '',
          memberCount: g.memberCount || 0
        }))
      }
    })
  }
}

// 工具 17: 获取联系人性别
const getContactGenderTool: AgentTool = {
  name: 'get_contact_gender',
  description: '获取指定联系人的性别信息。适用于：查询某某好友的性别、了解联系人性别信息。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称（昵称或备注）',
      required: true
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_contact_gender', args, async (args, onProgress) => {
      // 获取联系人列表
      const result = await window.electronAPI.chat.getContacts({ lite: true })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 查找联系人
      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      // 获取性别信息
      const genderResult = await window.electronAPI.chat.getContactGender(contact.username)

      if (!genderResult || !genderResult.success) {
        throw new Error(`获取性别信息失败：${genderResult?.error || '未知错误'}`)
      }

      return {
        contactName: contact.remark || contact.nickname || contact.username,
        username: contact.username,
        gender: genderResult.gender,
        genderText: genderResult.genderText
      }
    })
  }
}

// 工具 18: 分析好友性别分布
const analyzeFriendsGenderDistributionTool: AgentTool = {
  name: 'analyze_friends_gender_distribution',
  description: '分析所有好友的性别分布情况。适用于：统计男女比例、了解好友性别构成。',
  parameters: {},
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('analyze_friends_gender_distribution', args, async (args, onProgress) => {
      const result = await window.electronAPI.chat.getAllFriendsGenderDistribution()

      if (!result || !result.success) {
        throw new Error(`获取性别分布失败：${result?.error || '未知错误'}`)
      }

      const distribution = result.distribution!

      return {
        totalFriends: distribution.total,
        male: {
          count: distribution.male,
          percentage: Math.round((distribution.male / distribution.total) * 100)
        },
        female: {
          count: distribution.female,
          percentage: Math.round((distribution.female / distribution.total) * 100)
        },
        unknown: {
          count: distribution.unknown,
          percentage: Math.round((distribution.unknown / distribution.total) * 100)
        },
        summary: `共有${distribution.total}位好友，其中男性${distribution.male}人(${Math.round((distribution.male / distribution.total) * 100)}%)，女性${distribution.female}人(${Math.round((distribution.female / distribution.total) * 100)}%)，未知${distribution.unknown}人`
      }
    })
  }
}

// 工具 19: 获取指定城市天气
const getCityWeatherTool: AgentTool = {
  name: 'get_city_weather',
  description: '获取指定城市的当前天气信息。适用于：查询某个城市的天气、了解某地当前气温和天气状况。',
  parameters: {
    city: {
      type: 'string',
      description: '城市名称（支持中文，如：北京、上海、广州）',
      required: true
    },
    format: {
      type: 'string',
      description: '输出格式：simple(简洁格式，仅温度和天气) 或 detailed(详细格式，包含风速、湿度等)',
      required: false,
      enum: ['simple', 'detailed']
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_city_weather', args, async (args, onProgress) => {
      const city = args.city.trim()
      const format = args.format || 'simple'

      if (!city) {
        throw new Error('城市名称不能为空')
      }

      // 构建 wttr.in API URL
      const formatParam = format === 'detailed' 
        ? '%l:+%t+%C+%w+%h'  // 城市+温度+天气+风速+湿度
        : '%l:+%t+%C'         // 城市+温度+天气
      
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=${encodeURIComponent(formatParam)}&lang=zh`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'curl/7.68.0'  // wttr.in 需要 User-Agent
          }
        })

        if (!response.ok) {
          throw new Error(`获取天气失败：HTTP ${response.status}`)
        }

        const weatherText = await response.text()

        // 检查是否返回了错误信息
        if (weatherText.includes('Unknown location') || weatherText.includes('Not Found')) {
          throw new Error(`未找到城市"${city}"的天气信息，请检查城市名称是否正确`)
        }

        return {
          city: city,
          weather: weatherText.trim(),
          format: format,
          source: 'wttr.in'
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error
        }
        throw new Error(`获取天气信息失败：${String(error)}`)
      }
    })
  }
}

// 工具 21: 获取好友所在城市天气
const getContactWeatherTool: AgentTool = {
  name: 'get_contact_weather',
  description: '获取指定联系人所在城市的当前天气。适用于：了解某个好友那边的天气怎么样、关心好友所在地的天气状况。',
  parameters: {
    contactName: {
      type: 'string',
      description: '联系人名称（昵称或备注）',
      required: true
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_contact_weather', args, async (args, onProgress) => {
      // 获取联系人列表
      const result = await window.electronAPI.chat.getContacts({ lite: false })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      if (contacts.length === 0) {
        throw new Error('联系人列表为空')
      }

      // 查找联系人
      const { contact, similarContacts } = findContact(contacts, args.contactName)

      if (!contact) {
        const error: any = new Error(`未找到联系人"${args.contactName}"`)
        error.suggestions = similarContacts.length > 0 ? similarContacts : undefined
        throw error
      }

      // 解析地区信息获取城市
      const regionText = contact.region || ''
      const regionParts = regionText.split(/\s+/).filter(Boolean)
      
      let city = ''
      if (regionParts.length >= 3) {
        // 有国家信息，取城市（如：日本 冲绳县 冲绳群岛 -> 冲绳群岛）
        city = regionParts[2]
      } else if (regionParts.length === 2) {
        // 省份和城市（如：四川 成都 -> 成都）
        city = regionParts[1]
      } else if (regionParts.length === 1) {
        // 只有一项，直接使用
        city = regionParts[0]
      }

      if (!city) {
        throw new Error(`联系人"${contact.remark || contact.nickname || contact.username}"没有设置地区信息`)
      }

      // 获取天气
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=${encodeURIComponent('%l:+%t+%C')}&lang=zh`
      
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'curl/7.68.0'
          }
        })

        if (!response.ok) {
          throw new Error(`获取天气失败：HTTP ${response.status}`)
        }

        const weatherText = await response.text()

        if (weatherText.includes('Unknown location') || weatherText.includes('Not Found')) {
          throw new Error(`无法获取"${city}"的天气信息`)
        }

        return {
          contactName: contact.remark || contact.nickname || contact.username,
          city: city,
          region: regionText,
          weather: weatherText.trim(),
          source: 'wttr.in'
        }
      } catch (error) {
        if (error instanceof Error) {
          throw error
        }
        throw new Error(`获取天气信息失败：${String(error)}`)
      }
    })
  }
}

// 工具 22: 获取群聊成员城市天气分布
const analyzeGroupWeatherDistributionTool: AgentTool = {
  name: 'analyze_group_weather_distribution',
  description: '分析指定群聊成员所在城市的天气分布情况。适用于：了解群里大家那边的天气状况、群成员所在地的天气概况。',
  parameters: {
    groupName: {
      type: 'string',
      description: '群聊名称',
      required: true
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('analyze_group_weather_distribution', args, async (args, onProgress) => {
      // 获取群聊列表
      const groupsResult = await window.electronAPI.groupAnalytics.getGroupChats()
      const groups = groupsResult?.data || []

      // 查找群聊
      const searchName = args.groupName.toLowerCase()
      const group =
        groups.find(
          (g: any) => g.displayName?.toLowerCase() === searchName || g.username === args.groupName
        ) || groups.find((g: any) => g.displayName?.toLowerCase().includes(searchName))

      if (!group) {
        const similarGroups = groups
          .filter((g: any) => g.displayName?.toLowerCase().includes(searchName))
          .slice(0, 5)
          .map((g: any) => g.displayName)

        const error: any = new Error(`未找到群聊"${args.groupName}"`)
        error.suggestions = similarGroups.length > 0 ? similarGroups : undefined
        throw error
      }

      // 获取群成员
      const membersResult = await window.electronAPI.groupAnalytics.getGroupMembers(group.username)
      const members = membersResult?.data || []

      if (members.length === 0) {
        throw new Error(`群聊"${group.displayName}"没有成员信息`)
      }

      // 获取所有联系人（用于查找地区信息）
      const contactsResult = await window.electronAPI.chat.getContacts({ lite: false })
      const allContacts = contactsResult?.contacts || []
      
      // 构建用户名到联系人的映射
      const contactMap = new Map(allContacts.map((c: any) => [c.username, c]))

      // 逐个获取每个成员的天气信息
      const memberWeatherList: Array<{
        memberName: string
        city: string
        region: string
        weather: string
        hasWeather: boolean
      }> = []

      // 用于缓存已获取的城市天气，避免重复请求
      const cityWeatherCache: Record<string, string> = {}

      for (const member of members) {
        const contact = contactMap.get(member.username)
        if (!contact || !contact.region) {
          memberWeatherList.push({
            memberName: contact?.remark || contact?.nickname || member.username,
            city: '',
            region: '',
            weather: '未设置地区信息',
            hasWeather: false
          })
          continue
        }

        const regionParts = contact.region.split(/\s+/).filter(Boolean)
        let city = ''
        if (regionParts.length >= 3) {
          city = regionParts[2]
        } else if (regionParts.length === 2) {
          city = regionParts[1]
        } else if (regionParts.length === 1) {
          city = regionParts[0]
        }

        if (!city) {
          memberWeatherList.push({
            memberName: contact.remark || contact.nickname || member.username,
            city: '',
            region: contact.region,
            weather: '无法解析城市信息',
            hasWeather: false
          })
          continue
        }

        const displayName = contact.remark || contact.nickname || member.username

        // 检查缓存
        let weather = cityWeatherCache[city]
        
        // 如果没有缓存，获取天气
        if (!weather) {
          try {
            const url = `https://wttr.in/${encodeURIComponent(city)}?format=${encodeURIComponent('%l:+%t+%C')}&lang=zh`
            const response = await fetch(url, {
              method: 'GET',
              headers: { 'User-Agent': 'curl/7.68.0' }
            })

            if (response.ok) {
              const weatherText = await response.text()
              if (!weatherText.includes('Unknown location')) {
                weather = weatherText.trim()
                cityWeatherCache[city] = weather
              }
            }
          } catch (e) {
            console.warn(`获取${city}天气失败:`, e)
          }
        }

        memberWeatherList.push({
          memberName: displayName,
          city,
          region: contact.region,
          weather: weather || '获取天气失败',
          hasWeather: !!weather
        })
      }

      // 统计信息
      const membersWithWeather = memberWeatherList.filter(m => m.hasWeather)
      const uniqueCities = [...new Set(membersWithWeather.map(m => m.city))]

      return {
        groupName: group.displayName,
        totalMembers: members.length,
        membersWithRegion: memberWeatherList.filter(m => m.region).length,
        membersWithWeather: membersWithWeather.length,
        cityCount: uniqueCities.length,
        memberWeatherList,
        summary: `群"${group.displayName}"共有${members.length}位成员，其中${memberWeatherList.filter(m => m.region).length}位设置了地区信息，成功获取了${membersWithWeather.length}位成员的天气信息，分布在${uniqueCities.length}个城市`
      }
    })
  }
}

// 工具 23: 分析所有好友的城市天气分布
const analyzeFriendsWeatherDistributionTool: AgentTool = {
  name: 'analyze_friends_weather_distribution',
  description: '分析所有好友所在城市的天气分布情况。适用于：了解好友们那边的天气状况、关心分布在各地的朋友们。',
  parameters: {},
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('analyze_friends_weather_distribution', args, async (args, onProgress) => {
      // 获取所有联系人
      const result = await window.electronAPI.chat.getContacts({ lite: false })

      if (!result || !result.success) {
        throw new Error(`获取联系人列表失败：${result?.error || '未知错误'}`)
      }

      const contacts = Array.isArray(result.contacts) ? result.contacts : []

      // 逐个获取每个好友的天气信息
      const friendWeatherList: Array<{
        friendName: string
        username: string
        city: string
        region: string
        weather: string
        hasWeather: boolean
      }> = []

      // 用于缓存已获取的城市天气，避免重复请求
      const cityWeatherCache: Record<string, string> = {}

      for (const contact of contacts) {
        if (!contact.region || !contact.region.trim()) {
          friendWeatherList.push({
            friendName: contact.remark || contact.nickname || contact.username,
            username: contact.username,
            city: '',
            region: '',
            weather: '未设置地区信息',
            hasWeather: false
          })
          continue
        }

        const regionParts = contact.region.split(/\s+/).filter(Boolean)
        let city = ''
        if (regionParts.length >= 3) {
          city = regionParts[2]
        } else if (regionParts.length === 2) {
          city = regionParts[1]
        } else if (regionParts.length === 1) {
          city = regionParts[0]
        }

        if (!city) {
          friendWeatherList.push({
            friendName: contact.remark || contact.nickname || contact.username,
            username: contact.username,
            city: '',
            region: contact.region,
            weather: '无法解析城市信息',
            hasWeather: false
          })
          continue
        }

        const displayName = contact.remark || contact.nickname || contact.username

        // 检查缓存
        let weather = cityWeatherCache[city]
        
        // 如果没有缓存，获取天气
        if (!weather) {
          try {
            const url = `https://wttr.in/${encodeURIComponent(city)}?format=${encodeURIComponent('%l:+%t+%C')}&lang=zh`
            const response = await fetch(url, {
              method: 'GET',
              headers: { 'User-Agent': 'curl/7.68.0' }
            })

            if (response.ok) {
              const weatherText = await response.text()
              if (!weatherText.includes('Unknown location')) {
                weather = weatherText.trim()
                cityWeatherCache[city] = weather
              }
            }
          } catch (e) {
            console.warn(`获取${city}天气失败:`, e)
          }
        }

        friendWeatherList.push({
          friendName: displayName,
          username: contact.username,
          city,
          region: contact.region,
          weather: weather || '获取天气失败',
          hasWeather: !!weather
        })
      }

      // 统计信息
      const friendsWithWeather = friendWeatherList.filter(f => f.hasWeather)
      const uniqueCities = [...new Set(friendsWithWeather.map(f => f.city))]

      return {
        totalFriends: contacts.length,
        friendsWithRegion: friendWeatherList.filter(f => f.region).length,
        friendsWithWeather: friendsWithWeather.length,
        cityCount: uniqueCities.length,
        friendWeatherList,
        summary: `共有${contacts.length}位好友，其中${friendWeatherList.filter(f => f.region).length}位设置了地区信息，成功获取了${friendsWithWeather.length}位好友的天气信息，分布在${uniqueCities.length}个城市`
      }
    })
  }
}

// ============================================================================
// 用户自定义信息工具
// ============================================================================

const USER_INFO_STORAGE_KEY = 'chatflow_user_custom_info'

// 从 localStorage 读取持久化的用户自定义信息
function loadUserCustomInfo(): { nickname: string; city: string } {
  try {
    const stored = localStorage.getItem(USER_INFO_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      return {
        nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
        city: typeof parsed.city === 'string' ? parsed.city : ''
      }
    }
  } catch { /* ignore */ }
  return { nickname: '', city: '' }
}

// 保存用户自定义信息到 localStorage
function saveUserCustomInfo(nickname: string, city: string): void {
  try {
    localStorage.setItem(USER_INFO_STORAGE_KEY, JSON.stringify({ nickname, city }))
  } catch { /* ignore */ }
}

// 从 region 字符串中提取城市名（"四川 遂宁" → "遂宁"）
function extractCityFromRegion(region: string | undefined): string {
  if (!region) return ''
  const parts = region.trim().split(/\s+/)
  if (parts.length >= 2) {
    // 去掉第一部分（省份），返回第二部分（城市）
    return parts[1]
  }
  return region.trim()
}

// 辅助：优先取 localStorage 中的手动设置值，没有则尝试从微信数据库获取
async function resolveUserInfo(): Promise<{ nickname: string; city: string; source: string }> {
  const stored = loadUserCustomInfo()

  // 如果 localStorage 已有设置，优先使用（用户手动设置优先）
  if (stored.nickname || stored.city) {
    return {
      nickname: stored.nickname,
      city: stored.city,
      source: 'manual'
    }
  }

  // 否则从微信数据库自动获取
  let nickname = ''
  let city = ''
  try {
    // 昵称：复用 Sidebar 的方式（getMyAvatarUrl）
    const avatarResult = await window.electronAPI.chat.getMyAvatarUrl()
    if (avatarResult?.success && avatarResult.displayName) {
      nickname = avatarResult.displayName
    }

    // 城市：从 getMyInfo 的 region 中提取城市部分
    const myInfoResult = await window.electronAPI.chat.getMyInfo()
    if (myInfoResult?.success && myInfoResult.region) {
      city = extractCityFromRegion(myInfoResult.region)
    }
  } catch (e) {
    console.warn('[getMyCustomInfo] 从微信数据库获取失败:', e)
  }

  return { nickname, city, source: nickname || city ? 'wechat_auto' : 'none' }
}

const setUserInfoTool: AgentTool = {
  name: 'set_my_info',
  description:
    '设置用户自己的信息（昵称、所在城市）。也可以不传参数查询当前状态。此工具会优先使用微信数据库中已有的信息，自动获取昵称和城市，无需用户手动设置。',
  parameters: {
    nickname: {
      type: 'string',
      description: '用户希望被称呼的昵称（可选，不传则自动从微信获取）',
      required: false
    },
    city: {
      type: 'string',
      description: '用户所在城市（可选，不传则自动从微信获取）',
      required: false
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('set_my_info', args, async (args, onProgress) => {
      // 先尝试从微信数据库自动获取
      const autoInfo = await resolveUserInfo()
      const { nickname: autoNickname, city: autoCity } = autoInfo

      // 如果不传参数，只返回当前状态
      if (!args.nickname && !args.city) {
        const stored = loadUserCustomInfo()
        return {
          message: `当前昵称：${stored.nickname || autoNickname || '(未设置)'}\n当前城市：${stored.city || autoCity || '(未设置)'}`,
          nickname: stored.nickname || autoNickname || null,
          city: stored.city || autoCity || null,
          source: stored.nickname ? 'manual' : (autoNickname ? 'wechat_auto' : 'none')
        }
      }

      // 保存手动设置值（优先于自动获取）
      const stored = loadUserCustomInfo()
      const newNickname = args.nickname !== undefined ? args.nickname : (stored.nickname || autoNickname)
      const newCity = args.city !== undefined ? args.city : (stored.city || autoCity)
      saveUserCustomInfo(newNickname, newCity)

      return {
        success: true,
        message: `已设置：昵称="${newNickname || '(未设置)'}"，城市="${newCity || '(未设置)'}"`,
        nickname: newNickname || null,
        city: newCity || null
      }
    })
  }
}

const getMyCustomInfoTool: AgentTool = {
  name: 'get_my_custom_info',
  description:
    '获取当前用户自己的昵称和城市信息。优先从微信数据库自动获取（左下角昵称 + 通讯录地区），也会使用用户手动设置的值。',
  parameters: {
    format: {
      type: 'string',
      description: '输出格式：simple(简洁) 或 detailed(详细)',
      required: false,
      enum: ['simple', 'detailed']
    }
  },
  execute: async (args, onProgress) => {
    return executeToolWithWrapper('get_my_custom_info', args, async (args, onProgress) => {
      const { nickname, city, source } = await resolveUserInfo()

      if (args.format === 'simple') {
        if (!nickname && !city) {
          return {
            nickname: null,
            city: null,
            source: 'none',
            message: '未获取到昵称和城市'
          }
        }
        return {
          nickname: nickname || null,
          city: city || null,
          source,
          message: nickname && city ? `${nickname}，${city}` : (nickname || city)
        }
      }

      return {
        nickname: nickname || null,
        city: city || null,
        hasNickname: Boolean(nickname),
        hasCity: Boolean(city),
        source,
        message: nickname && city
          ? `昵称：${nickname}（来源：${source === 'wechat_auto' ? '微信数据库自动获取' : '手动设置'}）\n城市：${city}`
          : nickname
            ? `昵称：${nickname}（来源：${source === 'wechat_auto' ? '微信数据库自动获取' : '手动设置'}）\n城市：(未设置)`
            : city
              ? `昵称：(未设置)\n城市：${city}（来源：${source === 'wechat_auto' ? '微信数据库自动获取' : '手动设置'}）`
              : `昵称：(未设置)\n城市：(未设置)`
      }
    })
  }
}

// ============================================================================
// 导出所有工具
// ============================================================================

export const agentTools: AgentTool[] = [
  setUserInfoTool,
  getMyCustomInfoTool,
  chatSummaryTool,
  groupChatSummaryTool,
  smartSearchTool,
  replySuggestionTool,
  conversationStarterTool,
  snsAnalysisTool,
  groupRoleAnalysisTool,
  emotionCalendarTool,
  voiceSummaryTool,
  relationshipTimelineTool,
  anniversaryFinderTool,
  chatStyleProfileTool,
  relationshipHealthTool,
  messageClassificationTool,
  promiseTrackerTool,
  listAllContactsTool,
  getContactRegionTool,
  getMyRegionTool,
  getMyWeatherTool,
  analyzeContactsRegionDistributionTool,
  getContactSignatureTool,
  listAllGroupsTool,
  getContactGenderTool,
  analyzeFriendsGenderDistributionTool,
  getCityWeatherTool,
  getContactWeatherTool,
  analyzeGroupWeatherDistributionTool,
  analyzeFriendsWeatherDistributionTool
]

/**
 * 根据名称获取工具
 */
export function getToolByName(name: string): AgentTool | undefined {
  return agentTools.find((t) => t.name === name)
}

/**
 * 生成 OpenAI Function Calling 格式的工具定义
 */
export function buildOpenAIFunctionTools(): OpenAIFunctionTool[] {
  return agentTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([key, val]) => [
            key,
            {
              type: val.type,
              description: val.description,
              ...(val.enum ? { enum: val.enum } : {})
            }
          ])
        ),
        required: Object.entries(t.parameters)
          .filter(([, val]) => val.required)
          .map(([key]) => key)
      }
    }
  }))
}

/**
 * 生成工具描述（给 LLM 的 system prompt 用）
 */
export function getToolsDescription(): string {
  return agentTools
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(
          ([key, val]) =>
            `  - ${key} (${val.type}${val.required ? ', 必填' : ''}): ${val.description}${val.enum ? ` 可选值: ${val.enum.join('/')}` : ''}`
        )
        .join('\n')
      return `### ${t.name}\n${t.description}\n参数:\n${params}`
    })
    .join('\n\n')
}

/**
 * 执行指定工具（供外部调用）
 * @param toolName 工具名称
 * @param args 工具参数
 * @returns 标准化的工具执行结果
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any>
): Promise<ToolExecutionResult> {
  const tool = getToolByName(toolName)
  if (!tool) {
    return {
      success: false,
      error: `未知工具: ${toolName}`
    }
  }

  try {
    const result = await tool.execute(args)

    // 如果已经是标准格式，直接返回
    if (result && typeof result === 'object' && 'success' in result) {
      return result as ToolExecutionResult
    }

    // 否则包装为标准格式
    return {
      success: true,
      data: result,
      metadata: {
        toolName
      }
    }
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || error?.toString() || '工具执行失败',
      metadata: {
        toolName
      }
    }
  }
}

/**
 * 清除工具缓存
 */
export function clearToolCache(toolName?: string): void {
  if (toolName) {
    toolResultCache.clearByToolName(toolName)
  } else {
    toolResultCache.clear()
  }
}

/**
 * 获取缓存统计信息
 */
export function getToolCacheStats(): { size: number; keys: string[] } {
  return toolResultCache.getStats()
}

/**
 * 获取正在执行的工具调用数量
 */
export function getPendingToolExecutions(): number {
  return toolExecutionDeduplicator.getPendingCount()
}

/**
 * 获取所有工具
 */
export function getAllTools(): AgentTool[] {
  return [...agentTools]
}

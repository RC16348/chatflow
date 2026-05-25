/**
 * insightService.ts
 *
 * AI 见解后台服务：
 * 1. 监听 DB 变更事件（debounce 500ms 防抖，避免开机/重连时爆发大量事件阻塞主线程）
 * 2. 沉默联系人扫描（独立 setInterval，每 4 小时一次）
 * 3. 触发后拉取真实聊天上下文（若用户授权），组装 prompt 调用单一 AI 模型
 * 4. 输出 ≤80 字见解，通过现有 showNotification 弹出右下角通知
 *
 * 设计原则：
 * - 不引入任何额外 npm 依赖，使用 Node 原生 https 模块调用 OpenAI 兼容 API
 * - 所有失败静默处理，不影响主流程
 * - 当日触发记录（sessionId + 时间列表）随 prompt 一起发送，让模型自行判断是否克制
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { Notification } from 'electron'
import { ConfigService } from './config'
import { chatService, ChatSession, Message } from './chatService'
import { ContactCacheService } from './contactCacheService'
import { fetchApiKey, clearApiKeyCache } from './authService'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/**
 * DB 变更防抖延迟（毫秒）。
 * 设为 2s：微信写库通常是批量操作，500ms 过短会在开机/重连时产生大量连续触发。
 */
const DB_CHANGE_DEBOUNCE_MS = 2000

/** 首次沉默扫描延迟（毫秒），避免启动期间抢占资源 */
const SILENCE_SCAN_INITIAL_DELAY_MS = 3 * 60 * 1000

/** 单次 API 请求超时（毫秒） */
const API_TIMEOUT_MS = 45_000

/** 沉默天数阈值默认值 */
const DEFAULT_SILENCE_DAYS = 3
const INSIGHT_CONFIG_KEYS = new Set([
  'aiInsightEnabled',
  'aiInsightScanIntervalHours',
  'aiInsightCooldownMinutes',
  'aiInsightSilenceDays',
  'aiInsightWhitelistEnabled',
  'aiInsightWhitelist',
  'aiInsightAllowContext',
  'aiInsightContextCount',
  'aiInsightSystemPrompt',
  'aiInsightApiBaseUrl',
  'aiInsightApiKey',
  'aiInsightApiModel',
  'dbPath',
  'decryptKey',
  'myWxid'
])

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface TodayTriggerRecord {
  /** 该会话今日触发的时间戳列表（毫秒） */
  timestamps: number[]
}

// ─── 日志 ─────────────────────────────────────────────────────────────────────

/**
 * 仅输出到 console，不落盘到文件。
 */
function insightLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  if (level === 'ERROR' || level === 'WARN') {
    console.warn(`[InsightService] ${message}`)
  } else {
    console.log(`[InsightService] ${message}`)
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 绝对拼接 baseUrl 与路径，避免 Node.js URL 相对路径陷阱。
 *
 * 例如：
 *   baseUrl = "https://api.ohmygpt.com/v1"
 *   path    = "/chat/completions"
 * 结果为  "https://api.ohmygpt.com/v1/chat/completions"
 *
 * 如果 baseUrl 末尾没有斜杠，直接用字符串拼接（而非 new URL(path, base)），
 * 因为 new URL("chat/completions", "https://api.example.com/v1") 会错误地
 * 丢弃 v1，变成 https://api.example.com/chat/completions。
 */
function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '') // 去掉末尾斜杠
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * 构建完整的 API 端点 URL（包含 /v1 前缀）
 * OpenAI 兼容 API 标准路径为 /v1/chat/completions
 */
function buildOpenAIApiUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '') // 去掉末尾斜杠
  // 如果 baseUrl 已经包含 /v1 结尾，直接拼接 /chat/completions
  // 否则添加 /v1/chat/completions
  if (base.endsWith('/v1')) {
    return `${base}/chat/completions`
  }
  return `${base}/v1/chat/completions`
}

function getStartOfDay(date: Date = new Date()): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/**
 * 调用 OpenAI 兼容 API（非流式），返回模型第一条消息内容。
 * 使用 Node 原生 https/http 模块，无需任何第三方 SDK。
 */
function callApi(
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const endpoint = buildOpenAIApiUrl(apiBaseUrl)
    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch (e) {
      reject(new Error(`无效的 API URL: ${endpoint}`))
      return
    }

    const body = JSON.stringify({
      model,
      messages,
      max_tokens: 200,
      temperature: 0.7,
      stream: false
    })

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        Authorization: `Bearer ${apiKey}`
      }
    }

    const isHttps = urlObj.protocol === 'https:'
    const requestFn = isHttps ? https.request : http.request
    const req = requestFn(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          // 检查HTTP状态码
          const statusCode = res.statusCode || 0
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`API请求失败: ${statusCode} - ${data.slice(0, 500)}`))
            return
          }

          const parsed = JSON.parse(data)

          // 检查API返回的错误信息
          if (parsed?.error) {
            const errorMessage = parsed.error.message || parsed.error.code || JSON.stringify(parsed.error)
            reject(new Error(`API错误: ${errorMessage}`))
            return
          }

          const content = parsed?.choices?.[0]?.message?.content
          if (typeof content === 'string' && content.trim()) {
            resolve(content.trim())
          } else {
            reject(new Error(`API 返回格式异常: ${data.slice(0, 200)}`))
          }
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`))
        }
      })
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('API 请求超时'))
    })

    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

// ─── InsightService 主类 ──────────────────────────────────────────────────────

class InsightService {
  private readonly config: ConfigService

  /** DB 变更防抖定时器 */
  private dbDebounceTimer: NodeJS.Timeout | null = null

  /** 沉默扫描定时器 */
  private silenceScanTimer: NodeJS.Timeout | null = null
  private silenceInitialDelayTimer: NodeJS.Timeout | null = null

  /** 是否正在处理中（防重入） */
  private processing = false

  /**
   * 当日触发记录：sessionId -> TodayTriggerRecord
   * 每天 00:00 之后自动重置（通过检查日期实现）
   */
  private todayTriggers: Map<string, TodayTriggerRecord> = new Map()
  private todayDate = getStartOfDay()

  /**
   * 活跃分析冷却记录：sessionId -> 上次分析时间戳（毫秒）
   * 同一会话 2 小时内不重复触发活跃分析，防止 DB 频繁变更时爆量调用 API。
   */
  private lastActivityAnalysis: Map<string, number> = new Map()

  /**
   * 跟踪每个会话上次见到的最新消息时间戳，用于判断是否有真正的新消息。
   * sessionId -> lastMessageTimestamp（秒，与微信 DB 保持一致）
   */
  private lastSeenTimestamp: Map<string, number> = new Map()

  /**
   * 本地会话快照缓存，避免 analyzeRecentActivity 在每次 DB 变更时都做全量读取。
   * 首次调用时填充，此后只在沉默扫描里刷新（沉默扫描间隔更长，更合适做全量刷新）。
   */
  private sessionCache: ChatSession[] | null = null
  /** sessionCache 最后刷新时间戳（ms），超过 15 分钟强制重新拉取 */
  private sessionCacheAt = 0
  /** 缓存 TTL 设为 15 分钟，大幅减少 connect() + getSessions() 调用频率 */
  private static readonly SESSION_CACHE_TTL_MS = 15 * 60 * 1000
  /** 数据库是否已连接（避免重复调用 chatService.connect()） */
  private dbConnected = false

  private started = false

  constructor() {
    this.config = ConfigService.getInstance()
  }

  // ── 公开 API ────────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshConfiguration('startup')
  }

  stop(): void {
    const hadActiveFlow =
      this.dbDebounceTimer !== null ||
      this.silenceScanTimer !== null ||
      this.silenceInitialDelayTimer !== null ||
      this.activityFallbackTimer !== null ||
      this.processing
    this.started = false
    this.clearAllTimers()
    this.clearRuntimeCache()
    this.processing = false
    if (hadActiveFlow) {
      insightLog('INFO', '已停止')
    }
  }

  async handleConfigChanged(key: string): Promise<void> {
    const normalizedKey = String(key || '').trim()
    if (!INSIGHT_CONFIG_KEYS.has(normalizedKey)) return

    // 数据库相关配置变更后，丢弃缓存并强制下次重连
    if (normalizedKey === 'dbPath' || normalizedKey === 'decryptKey' || normalizedKey === 'myWxid') {
      this.clearRuntimeCache()
    }

    await this.refreshConfiguration(`config:${normalizedKey}`)
  }

  handleConfigCleared(): void {
    this.clearAllTimers()
    this.clearRuntimeCache()
    this.processing = false
  }

  private async refreshConfiguration(_reason: string): Promise<void> {
    if (!this.started) return
    if (!this.isEnabled()) {
      this.clearTimers()
      this.clearRuntimeCache()
      this.processing = false
      return
    }
    this.scheduleSilenceScan()
    // 配置变更后立即触发一次活跃分析，确保后台服务能正确启动
    // 不依赖 DB 监控事件（因为 DB 监控可能尚未启动）
    insightLog('INFO', `配置已刷新 (${_reason})，触发一次活跃分析`)
    void this.triggerActivityAnalysis()
  }

  private clearRuntimeCache(): void {
    this.dbConnected = false
    this.sessionCache = null
    this.sessionCacheAt = 0
    this.lastActivityAnalysis.clear()
    this.lastSeenTimestamp.clear()
    this.todayTriggers.clear()
    this.todayDate = getStartOfDay()
  }

  private clearTimers(): void {
    // 注意：不清除 dbDebounceTimer，它由 handleDbMonitorChange 独立管理
    // scheduleSilenceScan 调用 clearTimers 时不应影响 DB 变更防抖
    if (this.silenceScanTimer !== null) {
      clearTimeout(this.silenceScanTimer)
      this.silenceScanTimer = null
    }
    if (this.silenceInitialDelayTimer !== null) {
      clearTimeout(this.silenceInitialDelayTimer)
      this.silenceInitialDelayTimer = null
    }
    if (this.activityFallbackTimer !== null) {
      clearTimeout(this.activityFallbackTimer)
      this.activityFallbackTimer = null
    }
  }

  /** 停止服务时调用，清除所有定时器包括 DB 防抖 */
  private clearAllTimers(): void {
    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
      this.dbDebounceTimer = null
    }
    this.clearTimers()
  }

  /**
   * 由 main.ts 在 addDbMonitorListener 回调中调用。
   * 加入 2s 防抖，防止开机/重连时大量事件并发阻塞主线程。
   * 注意：不检查 processing 标志，因为防抖机制本身就能合并事件。
   * 如果正在处理中，防抖到期后会重新检查（analyzeRecentActivity 内部检查 processing）。
   */
  handleDbMonitorChange(_type: string, _json: string): void {
    if (!this.started) return
    if (!this.isEnabled()) return

    if (this.dbDebounceTimer !== null) {
      clearTimeout(this.dbDebounceTimer)
    }
    this.dbDebounceTimer = setTimeout(() => {
      this.dbDebounceTimer = null
      void this.analyzeRecentActivity()
    }, DB_CHANGE_DEBOUNCE_MS)
  }

  /**
   * 手动触发活跃分析（供外部调用，不依赖 DB 监控事件）。
   * 用于配置变更后立即触发一次分析，确保后台服务能正确启动。
   * 注意：此方法不设置 processing 标志，不会阻塞 DB 变更事件。
   */
  async triggerActivityAnalysis(): Promise<void> {
    if (!this.started) return
    if (!this.isEnabled()) return
    // 不检查 processing，允许与 DB 变更事件并行
    // 但 analyzeRecentActivity 内部会检查 processing，避免真正并发执行
    await this.analyzeRecentActivity()
  }

  /**
   * 获取 API 配置，优先从云端获取，失败时回退到本地配置
   */
  private async getApiConfig(): Promise<{ apiBaseUrl: string; apiKey: string; model: string } | null> {
    // 1. 优先尝试从云端获取 API Key
    try {
      const cloudResult = await fetchApiKey()
      if (cloudResult.authorized && cloudResult.has_key && cloudResult.api_key) {
        insightLog('INFO', '从云端获取 API 配置成功')
        return {
          apiBaseUrl: cloudResult.api_url || 'https://api.deepseek.com',
          apiKey: cloudResult.api_key,
          model: cloudResult.model || 'gpt-4o-mini'
        }
      }
    } catch (error) {
      insightLog('WARN', `从云端获取 API 配置失败: ${(error as Error).message}`)
    }

    // 2. 回退到本地配置
    const apiBaseUrl = this.config.get('aiInsightApiBaseUrl') as string
    const apiKey = this.config.get('aiInsightApiKey') as string
    const model = (this.config.get('aiInsightApiModel') as string) || 'gpt-4o-mini'

    if (apiBaseUrl && apiKey) {
      insightLog('INFO', '使用本地 API 配置')
      return { apiBaseUrl, apiKey, model }
    }

    return null
  }

  /**
   * 测试 API 连接，返回 { success, message }。
   * 供设置页"测试连接"按钮调用。
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    const config = await this.getApiConfig()

    if (!config) {
      return { success: false, message: '请先填写 API 地址和 API Key，或确保已授权可获取云端配置' }
    }

    try {
      const result = await callApi(
        config.apiBaseUrl,
        config.apiKey,
        config.model,
        [{ role: 'user', content: '请回复"连接成功"四个字。' }],
        15_000
      )
      return { success: true, message: `连接成功，模型回复：${result.slice(0, 50)}` }
    } catch (e) {
      return { success: false, message: `连接失败：${(e as Error).message}` }
    }
  }

  /**
   * 强制立即对最近一个私聊会话触发一次见解（忽略冷却，用于测试）。
   * 返回触发结果描述，供设置页展示。
   */
  async triggerTest(): Promise<{ success: boolean; message: string }> {
    insightLog('INFO', '手动触发测试见解...')
    const config = await this.getApiConfig()
    if (!config) {
      return { success: false, message: '请先填写 API 地址和 Key，或确保已授权可获取云端配置' }
    }
    try {
      const connectResult = await chatService.connect()
      if (!connectResult.success) {
        return { success: false, message: '数据库连接失败，请先在"数据库连接"页完成配置' }
      }
      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions || sessionsResult.sessions.length === 0) {
        return { success: false, message: '未找到任何会话，请确认数据库已正确连接' }
      }
      // 找第一个允许的私聊
      const session = (sessionsResult.sessions as ChatSession[]).find((s) => {
        const id = s.username?.trim() || ''
        return id && !id.endsWith('@chatroom') && !id.toLowerCase().includes('placeholder') && this.isSessionAllowed(id)
      })
      if (!session) {
        return { success: false, message: '未找到任何私聊会话（若已启用白名单，请检查是否有勾选的私聊）' }
      }
      const sessionId = session.username?.trim() || ''
      const displayName = session.displayName || sessionId
      insightLog('INFO', `测试目标会话：${displayName} (${sessionId})`)
      await this.generateInsightForSession({
        sessionId,
        displayName,
        triggerReason: 'activity'
      })
      return { success: true, message: `已向「${displayName}」发送测试见解，请查看右下角弹窗` }
    } catch (e) {
      return { success: false, message: `测试失败：${(e as Error).message}` }
    }
  }

  /** 获取今日触发统计（供设置页展示） */
  getTodayStats(): { sessionId: string; count: number; times: string[] }[] {
    this.resetIfNewDay()
    const result: { sessionId: string; count: number; times: string[] }[] = []
    for (const [sessionId, record] of this.todayTriggers.entries()) {
      result.push({
        sessionId,
        count: record.timestamps.length,
        times: record.timestamps.map(formatTimestamp)
      })
    }
    return result
  }

  // ── 私有方法 ────────────────────────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.config.get('aiInsightEnabled') === true
  }

  /**
   * 判断某个会话是否允许触发见解。
   * 若白名单未启用，则所有私聊会话均允许；
   * 若白名单已启用，则只有在白名单中的会话才允许。
   */
  private isSessionAllowed(sessionId: string): boolean {
    const whitelistEnabled = this.config.get('aiInsightWhitelistEnabled') as boolean
    if (!whitelistEnabled) return true
    const whitelist = (this.config.get('aiInsightWhitelist') as string[]) || []
    return whitelist.includes(sessionId)
  }

  /**
   * 获取会话列表，优先使用缓存（15 分钟 TTL）。
   * 缓存命中时完全跳过数据库访问，避免频繁 connect() + getSessions() 消耗 CPU。
   * forceRefresh=true 时强制重新拉取（仅用于沉默扫描等低频场景）。
   */
  private async getSessionsCached(forceRefresh = false): Promise<ChatSession[]> {
    const now = Date.now()
    // 缓存命中：直接返回，零数据库操作
    if (
      !forceRefresh &&
      this.sessionCache !== null &&
      now - this.sessionCacheAt < InsightService.SESSION_CACHE_TTL_MS
    ) {
      return this.sessionCache
    }
    // 缓存未命中或强制刷新：连接数据库并拉取
    try {
      // 只在首次或强制刷新时调用 connect()，避免重复建立连接
      if (!this.dbConnected || forceRefresh) {
        const connectResult = await chatService.connect()
        if (!connectResult.success) {
          insightLog('WARN', '数据库连接失败，使用旧缓存')
          return this.sessionCache ?? []
        }
        this.dbConnected = true
      }
      const result = await chatService.getSessions()
      if (result.success && result.sessions) {
        this.sessionCache = result.sessions as ChatSession[]
        this.sessionCacheAt = now
      }
    } catch (e) {
      insightLog('WARN', `获取会话缓存失败: ${(e as Error).message}`)
      // 连接可能已断开，下次强制重连
      this.dbConnected = false
    }
    return this.sessionCache ?? []
  }

  private resetIfNewDay(): void {
    const todayStart = getStartOfDay()
    if (todayStart > this.todayDate) {
      this.todayDate = todayStart
      this.todayTriggers.clear()
    }
  }

  /**
   * 记录触发并返回该会话今日所有触发时间（用于组装 prompt）。
   */
  private recordTrigger(sessionId: string): string[] {
    this.resetIfNewDay()
    const existing = this.todayTriggers.get(sessionId) ?? { timestamps: [] }
    existing.timestamps.push(Date.now())
    this.todayTriggers.set(sessionId, existing)
    return existing.timestamps.map(formatTimestamp)
  }

  /**
   * 获取今日全局已触发次数（所有会话合计），用于 prompt 中告知模型全局上下文。
   */
  private getTodayTotalTriggerCount(): number {
    this.resetIfNewDay()
    let total = 0
    for (const record of this.todayTriggers.values()) {
      total += record.timestamps.length
    }
    return total
  }

  // ── 沉默联系人扫描 + 活跃联系人兜底扫描 ────────────────────────────────

  /**
   * 定时扫描策略：
   * 1. 沉默扫描：发现长期未联系的联系人，生成见解
   * 2. 活跃兜底扫描：检查最近有新消息的联系人，生成见解
   *
   * 活跃兜底扫描的目的是：即使 DB 变更监控（wcdbCore 的命名管道）因 DLL 加载失败、
   * 管道断开等原因不工作，定时扫描也能确保 AI 见解正常触发。
   */
  private activityFallbackTimer: NodeJS.Timeout | null = null
  private static readonly ACTIVITY_FALLBACK_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟（仅作为 DB 监控失效时的兜底）

  private scheduleSilenceScan(): void {
    this.clearTimers()
    if (!this.started || !this.isEnabled()) return

    // 等待扫描完成后再安排下一次，避免并发堆积
    const scheduleNext = () => {
      if (!this.started || !this.isEnabled()) return
      const intervalHours = (this.config.get('aiInsightScanIntervalHours') as number) || 4
      const intervalMs = Math.max(0.1, intervalHours) * 60 * 60 * 1000
      insightLog('INFO', `下次沉默扫描将在 ${intervalHours} 小时后执行`)
      this.silenceScanTimer = setTimeout(async () => {
        this.silenceScanTimer = null
        await this.runSilenceScan()
        scheduleNext()
      }, intervalMs)
    }

    this.silenceInitialDelayTimer = setTimeout(async () => {
      this.silenceInitialDelayTimer = null
      await this.runSilenceScan()
      scheduleNext()
    }, SILENCE_SCAN_INITIAL_DELAY_MS)

    // 启动活跃联系人兜底扫描（独立于沉默扫描）
    this.scheduleActivityFallback()
  }

  /**
   * 活跃联系人兜底扫描：每 5 分钟检查一次是否有新消息。
   * 作为 DB 变更监控的兜底机制，确保即使命名管道监控不工作，
   * AI 见解也能在检测到新消息时及时触发。
   */
  private scheduleActivityFallback(): void {
    if (this.activityFallbackTimer !== null) {
      clearTimeout(this.activityFallbackTimer)
      this.activityFallbackTimer = null
    }
    if (!this.started || !this.isEnabled()) return

    this.activityFallbackTimer = setTimeout(async () => {
      this.activityFallbackTimer = null
      if (!this.started || !this.isEnabled()) return

      insightLog('INFO', '执行活跃联系人兜底扫描...')
      await this.analyzeRecentActivity()

      // 安排下一次
      this.scheduleActivityFallback()
    }, InsightService.ACTIVITY_FALLBACK_INTERVAL_MS)
  }

  private async runSilenceScan(): Promise<void> {
    if (!this.isEnabled()) {
      return
    }
    if (this.processing) {
      insightLog('INFO', '沉默扫描：正在处理中，跳过本次')
      return
    }

    this.processing = true
    insightLog('INFO', '开始沉默联系人扫描...')
    try {
      const silenceDays = (this.config.get('aiInsightSilenceDays') as number) || DEFAULT_SILENCE_DAYS
      const thresholdMs = silenceDays * 24 * 60 * 60 * 1000
      const now = Date.now()

      insightLog('INFO', `沉默阈值：${silenceDays} 天`)

      // 沉默扫描间隔较长，强制刷新缓存以获取最新数据
      const sessions = await this.getSessionsCached(true)
      if (sessions.length === 0) {
        insightLog('WARN', '获取会话列表失败，跳过沉默扫描')
        return
      }

      insightLog('INFO', `共 ${sessions.length} 个会话，开始过滤...`)

      let silentCount = 0
      for (const session of sessions) {
        if (!this.isEnabled()) return
        const sessionId = session.username?.trim() || ''
        if (!sessionId || sessionId.endsWith('@chatroom')) continue
        if (sessionId.toLowerCase().includes('placeholder')) continue
        if (!this.isSessionAllowed(sessionId)) continue

        const lastTimestamp = (session.lastTimestamp || 0) * 1000
        if (!lastTimestamp || lastTimestamp <= 0) continue

        const silentMs = now - lastTimestamp
        if (silentMs < thresholdMs) continue

        silentCount++
        const silentDays = Math.floor(silentMs / (24 * 60 * 60 * 1000))
        insightLog('INFO', `发现沉默联系人：${session.displayName || sessionId}，已沉默 ${silentDays} 天`)

        await this.generateInsightForSession({
          sessionId,
          displayName: session.displayName || session.username,
          triggerReason: 'silence',
          silentDays
        })
      }
      insightLog('INFO', `沉默扫描完成，共发现 ${silentCount} 个沉默联系人`)
    } catch (e) {
      insightLog('ERROR', `沉默扫描出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
    }
  }

  // ── 活跃会话分析 ────────────────────────────────────────────────────────────

  /**
   * 在 DB 变更防抖后执行，分析最近活跃的会话。
   *
   * 触发条件（必须同时满足）：
   * 1. 会话有真正的新消息（lastTimestamp 比上次见到的更新）
   * 2. 该会话距上次活跃分析已超过冷却期
   *
   * 白名单启用时：直接使用白名单里的 sessionId，完全跳过 getSessions()。
   * 白名单未启用时：从缓存拉取全量会话后过滤私聊。
   */
  private async analyzeRecentActivity(): Promise<void> {
    if (!this.isEnabled()) return
    if (this.processing) return

    this.processing = true
    try {
      const now = Date.now()
      const cooldownMinutes = (this.config.get('aiInsightCooldownMinutes') as number) ?? 120
      const cooldownMs = cooldownMinutes * 60 * 1000
      const whitelistEnabled = this.config.get('aiInsightWhitelistEnabled') as boolean
      const whitelist = (this.config.get('aiInsightWhitelist') as string[]) || []

      // 白名单启用时，只处理白名单中的会话
      if (whitelistEnabled) {
        // 白名单为空时，不处理任何会话
        if (whitelist.length === 0) {
          insightLog('INFO', '白名单已启用但为空，跳过活跃分析')
          return
        }

        // 确保数据库已连接（首次时连接，之后复用）
        if (!this.dbConnected) {
          const connectResult = await chatService.connect()
          if (!connectResult.success) return
          this.dbConnected = true
        }

        for (const sessionId of whitelist) {
          if (!sessionId || sessionId.endsWith('@chatroom')) continue

          // 冷却期检查（先过滤，减少不必要的 DB 查询）
          if (cooldownMs > 0) {
            const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
            if (cooldownMs - (now - lastAnalysis) > 0) continue
          }

          // 让出事件循环，避免连续同步 DLL 调用阻塞主线程
          await new Promise<void>((r) => setImmediate(r))

          // 拉取最新 1 条消息，用时间戳判断是否有新消息，避免全量 getSessions()
          try {
            const msgsResult = await chatService.getLatestMessages(sessionId, 1)
            if (!msgsResult.success || !msgsResult.messages || msgsResult.messages.length === 0) continue

            const latestMsg = msgsResult.messages[0]
            const latestTs = Number(latestMsg.createTime) || 0
            const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0

            if (latestTs <= lastSeen) continue // 没有新消息
            this.lastSeenTimestamp.set(sessionId, latestTs)
          } catch {
            continue
          }

          insightLog('INFO', `白名单会话 ${sessionId} 有新消息，准备生成见解...`)
          this.lastActivityAnalysis.set(sessionId, now)

          // 从联系人缓存获取昵称，优先使用昵称而非微信号
          const contactCache = new ContactCacheService()
          const contactInfo = contactCache.get(sessionId)
          const displayName = contactInfo?.displayName || sessionId

          await this.generateInsightForSession({
            sessionId,
            displayName,
            triggerReason: 'activity'
          })
          break // 每次最多处理 1 个会话
        }
        return
      }

      // 白名单未启用：需要拉取全量会话列表，从中过滤私聊
      const sessions = await this.getSessionsCached()
      if (sessions.length === 0) return

      const privateSessions = sessions.filter((s) => {
        const id = s.username?.trim() || ''
        return id && !id.endsWith('@chatroom') && !id.toLowerCase().includes('placeholder')
      })

      for (const session of privateSessions.slice(0, 10)) {
        const sessionId = session.username?.trim() || ''
        if (!sessionId) continue

        const currentTimestamp = session.lastTimestamp || 0
        const lastSeen = this.lastSeenTimestamp.get(sessionId) ?? 0
        if (currentTimestamp <= lastSeen) continue
        this.lastSeenTimestamp.set(sessionId, currentTimestamp)

        if (cooldownMs > 0) {
          const lastAnalysis = this.lastActivityAnalysis.get(sessionId) ?? 0
          if (cooldownMs - (now - lastAnalysis) > 0) continue
        }

        insightLog('INFO', `${session.displayName || sessionId} 有新消息，准备生成见解...`)
        this.lastActivityAnalysis.set(sessionId, now)

        await this.generateInsightForSession({
          sessionId,
          displayName: session.displayName || session.username,
          triggerReason: 'activity'
        })
        break
      }
    } catch (e) {
      insightLog('ERROR', `活跃分析出错: ${(e as Error).message}`)
    } finally {
      this.processing = false
    }
  }

  // ── 核心见解生成 ────────────────────────────────────────────────────────────

  private async generateInsightForSession(params: {
    sessionId: string
    displayName: string
    triggerReason: 'activity' | 'silence'
    silentDays?: number
  }): Promise<void> {
    const { sessionId, displayName, triggerReason, silentDays } = params
    if (!sessionId) return
    if (!this.isEnabled()) return

    const config = await this.getApiConfig()
    const allowContext = this.config.get('aiInsightAllowContext') as boolean
    const contextCount = (this.config.get('aiInsightContextCount') as number) || 8

    insightLog('INFO', `generateInsightForSession: sessionId=${sessionId}, reason=${triggerReason}, contextCount=${contextCount}, api=${config ? '已配置' : '未配置'}`)

    if (!config) {
      insightLog('WARN', 'API 地址或 Key 未配置，跳过见解生成')
      return
    }

    // ── 构建 prompt ────────────────────────────────────────────────────────────

    // 今日触发统计（让模型具备时间与克制感）
    const sessionTriggerTimes = this.recordTrigger(sessionId)
    const totalTodayTriggers = this.getTodayTotalTriggerCount()

    // ── 先获取双方性别信息（用于后续上下文构建和辅助信息）────────────────────────
    let myGender = 0
    let contactGender = 0
    let auxiliaryInfoSection = ''
    let region = ''
    
    try {
      // 获取对方性别
      const contactGenderResult = await chatService.getContactGender(sessionId)
      contactGender = contactGenderResult.gender || 0
      
      // 获取当前用户性别
      try {
        const myInfoResult = await chatService.getMyInfo()
        if (myInfoResult.success && myInfoResult.username) {
          const myGenderResult = await chatService.getContactGender(myInfoResult.username)
          myGender = myGenderResult.gender || 0
        }
      } catch (e) {
        insightLog('WARN', `获取当前用户性别失败: ${(e as Error).message}`)
      }

      const genderMap: Record<number, string> = { 0: '未知', 1: '男', 2: '女' }
      const myGenderText = genderMap[myGender] || '未知'
      const contactGenderText = contactGenderResult.genderText || '未知'
      
      // 获取地区信息
      const contactCache = new ContactCacheService()
      const contactInfo = contactCache.get(sessionId)
      region = contactInfo?.region || ''
      
      // 天气信息（如果有地区）
      let weather = ''
      if (region) {
        const regionParts = region.split(/\s+/).filter(Boolean)
        let city = ''
        if (regionParts.length >= 3) {
          city = regionParts[2]
        } else if (regionParts.length === 2) {
          city = regionParts[1]
        } else if (regionParts.length === 1) {
          city = regionParts[0]
        }
        
        if (city) {
          try {
            const weatherResult = await chatService.getCityWeather(city)
            if (weatherResult.success && weatherResult.weather) {
              weather = weatherResult.weather
            }
          } catch (e) {
            insightLog('WARN', `获取天气失败: ${(e as Error).message}`)
          }
        }
      }

      // 构建辅助信息段落
      const infoParts: string[] = []
      if (myGenderText !== '未知' || contactGenderText !== '未知') {
        infoParts.push(`双方性别：我(${myGenderText}) / 对方(${contactGenderText})`)
      }
      if (region) {
        infoParts.push(`对方地区：${region}`)
      }
      if (weather) {
        infoParts.push(`对方天气：${weather}`)
      }
      
      if (infoParts.length > 0) {
        auxiliaryInfoSection = `\n\n辅助信息：\n${infoParts.join('\n')}`
        insightLog('INFO', `已加载辅助信息：性别、地区、天气`)
      }
    } catch (e) {
      insightLog('WARN', `获取辅助信息失败: ${(e as Error).message}`)
    }

    // ── 构建聊天上下文（包含性别标识）───────────────────────────────────────────
    let contextSection = ''
    if (allowContext) {
      try {
        const msgsResult = await chatService.getLatestMessages(sessionId, contextCount)
        if (msgsResult.success && msgsResult.messages && msgsResult.messages.length > 0) {
          const messages: Message[] = msgsResult.messages
          const genderMap: Record<number, string> = { 0: '', 1: '[男]', 2: '[女]' }
          const myGenderTag = genderMap[myGender] || ''
          const contactGenderTag = genderMap[contactGender] || ''
          
          const msgLines = messages.map((m) => {
            const isMe = m.isSend === 1
            const senderGenderTag = isMe ? myGenderTag : contactGenderTag
            const senderName = isMe ? '我' : (displayName || sessionId)
            const sender = `${senderGenderTag}${senderName}`
            const content = m.rawContent || m.parsedContent || '[非文字消息]'
            const time = new Date(Number(m.createTime) * 1000).toLocaleString('zh-CN')
            return `[${time}] ${sender}：${content}`
          })
          contextSection = `\n\n近期对话记录（最近 ${msgLines.length} 条）：\n${msgLines.join('\n')}`
          insightLog('INFO', `已加载 ${msgLines.length} 条上下文消息`)
        }
      } catch (e) {
        insightLog('WARN', `拉取上下文失败: ${(e as Error).message}`)
      }
    }

    // ── 默认 system prompt（稳定内容，有利于 provider 端 prompt cache 命中）────
    const DEFAULT_SYSTEM_PROMPT = `你是用户的私人关系观察助手，名叫"见解"。

【角色定义】
- "我" = 当前登录微信的用户（使用本助手的人，即你的服务对象）
- "对方" = 聊天对象（与"我"对话的另一方）
- 你必须始终站在"我"的角度，为"我"提供回复建议和关系观察

【分析逻辑】
先理清时间轴、发言方、回复间隔/时长，再按以下逻辑分析：
1.分析优先级：先判定对方情绪状态、聊天意愿，再分析话题趋势、关系动态，最终给"我"精准建议。
2.情绪判定铁则：结合语境、回复长度、语气、情绪关键词综合判断，不单一依赖关键词。
   - 对方情绪上扬：建议"我"适度回应，自然承接话题，不过度吹捧；可针对具体细节简短提问，但需判断关系亲疏和对方分享意愿，避免过度追问
   - 对方情绪低落：建议"我"适度共情，简短回应，不过度关心；严禁说教、强行正能量
   - 无情绪事务性消息：建议"我"直白应答，不强行接情绪
   - 出现疼/困/累/差劲等明确情绪词，建议"我"优先简短回应情绪，不过度展开
3.场景适配：精准识别敷衍、冷场、回避、终结话题、低聊天意愿信号，匹配对应方案，绝不强行续聊。
   - 对方有分享欲：给"我"自然续聊建议，避免过度热情
   - 对方无聊天意愿：给"我"体面收尾/暂停聊天建议，不硬撑尬聊
   - 对方表达不满/质疑时：建议"我"先理解对方诉求，而非急于解释或反驳，保持正常沟通姿态，不过度心理分析
4.回复风格：像正常人一样说话，避免"高情商话术"感。善用走心表达：用"确实"替代空洞赞美，用"像你这种人"点明特质，用"头一回"突出特殊性。
5.心法与技巧：
   - 关系阶段：判断亲疏，避免交浅言深；识别时机，对方有兴致时延续，冷淡时体面收尾
   - 情绪优先：核心是情绪互动，非内容高端；不一惊一乍、不自卑讨好、不提前结束有兴致的对话
   - 聊得好时：适时从"回复建议"转向"关系升温"
   - 互动方法：提取关键词用5W1H延伸；陈述代问降低压力；调动情绪→共情→推进，形成情绪流动
   - 情绪价值：建议"我"用"太棒了""心疼你"等感受词开头；事实+猜测+认同转感受；用"我也...""我懂..."造共同体验；用"看了...让我..."给情绪反馈；用"那你感觉呢？"追问引情绪
8.输出要求：80字以内，简洁一针见血，纯文本无冗余。仅遇单字无意义短句时回复SKIP，其余输出匹配场景的有效见解。`

    // 优先使用用户自定义 prompt，为空则使用默认值
    const customPrompt = (this.config.get('aiInsightSystemPrompt') as string) || ''
    const systemPrompt = customPrompt.trim() || DEFAULT_SYSTEM_PROMPT

    // 可变的上下文统计信息放在 user message 里，保持 system prompt 稳定不变
    // 这样 provider 端（Anthropic/OpenAI）能最大化命中 prompt cache，降低费用
    const triggerDesc =
      triggerReason === 'silence'
        ? `你已经 ${silentDays} 天没有和「${displayName}」聊天了。`
        : `你最近和「${displayName}」有新的聊天动态。`

    const todayStatsDesc =
      sessionTriggerTimes.length > 1
        ? `今天你已经针对「${displayName}」收到过 ${sessionTriggerTimes.length - 1} 条见解（时间：${sessionTriggerTimes.slice(0, -1).join('、')}），请适当克制。`
        : `今天你还没有针对「${displayName}」发出过见解。`

    const globalStatsDesc = `今天全部联系人合计已触发 ${totalTodayTriggers} 条见解。`

    // 【可补充发送给 AI 的信息建议】
    // 以下信息类型可以进一步增强 AI 的分析能力，建议以结构化格式追加到 userPrompt：
    //
    // 1. 消息类型分布：统计近期对话中文字/图片/语音/视频/表情/链接的占比
    //    格式: `消息类型分布: 文字45% 图片20% 语音10% 其他25%`
    //
    // 2. 回复间隔分析：计算双方平均回复间隔时间
    //    格式: `回复间隔: 对方平均8分钟，你平均3分钟`
    //
    // 3. 对话轮次统计：统计连续对话轮次和最后回复间隔
    //    格式: `当前对话已持续5轮，对方最后回复间隔12分钟`
    //
    // 4. 活跃时段分布：消息发送的时间分布（上午/下午/晚上）
    //    格式: `活跃时段: 主要在晚上8-10点`
    //
    // 5. 消息长度趋势：双方消息平均长度对比
    //    格式: `消息长度: 对方平均15字，你平均25字`
    //
    // 6. 情绪词统计：近期对话中出现的情绪关键词频次
    //    格式: `情绪词: 开心(3次) 累(2次) 烦(1次)`
    //
    // 7. 话题延续性：对方是否主动开启话题、是否追问细节
    //    格式: `话题主动性: 对方主动开启60% 追问率40%`

    const userPrompt = `触发原因：${triggerDesc}
时间统计：${todayStatsDesc} ${globalStatsDesc}${auxiliaryInfoSection}${contextSection}

请给出你的见解（≤80字）：`

    const endpoint = buildOpenAIApiUrl(config.apiBaseUrl)
    insightLog('INFO', `准备调用 API: ${endpoint}，模型: ${config.model}`)

    try {
      const result = await this.callApiWithRetry(
        config,
        systemPrompt,
        userPrompt,
        displayName
      )

      if (!result) {
        // 重试后仍然失败，已经记录过错误日志
        return
      }

      insightLog('INFO', `API 返回原文: ${result.slice(0, 150)}`)

      // 模型主动选择跳过
      if (result.trim().toUpperCase() === 'SKIP' || result.trim().startsWith('SKIP')) {
        insightLog('INFO', `模型选择跳过 ${displayName}`)
        return
      }
      if (!this.isEnabled()) return

      const insight = result.slice(0, 120)
      const notifTitle = `见解 · ${displayName}`

      insightLog('INFO', `推送通知 → ${displayName}: ${insight}`)

      // 渠道一：Electron 原生系统通知
      if (Notification.isSupported()) {
        const notif = new Notification({ title: notifTitle, body: insight, silent: false })
        notif.show()
      } else {
        insightLog('WARN', '当前系统不支持原生通知')
      }

      // 渠道二：Telegram Bot 推送（可选）
      const telegramEnabled = this.config.get('aiInsightTelegramEnabled') as boolean
      if (telegramEnabled) {
        const telegramToken = (this.config.get('aiInsightTelegramToken') as string) || ''
        const telegramChatIds = (this.config.get('aiInsightTelegramChatIds') as string) || ''
        if (telegramToken && telegramChatIds) {
          const chatIds = telegramChatIds.split(',').map((s) => s.trim()).filter(Boolean)
          const telegramText = `【ChatFlow】 ${notifTitle}\n\n${insight}`
          for (const chatId of chatIds) {
            this.sendTelegram(telegramToken, chatId, telegramText).catch((e) => {
              insightLog('WARN', `Telegram 推送失败 (chatId=${chatId}): ${(e as Error).message}`)
            })
          }
        } else {
          insightLog('WARN', 'Telegram 已启用但 Token 或 Chat ID 未填写，跳过')
        }
      }

      insightLog('INFO', `已为 ${displayName} 推送见解`)
    } catch (e) {
      insightLog('ERROR', `API 调用失败 (${displayName}): ${(e as Error).message}`)
    }
  }

  /**
   * 调用API并支持自动刷新配置重试
   * 当遇到401/403等授权错误时，自动清除缓存并重新获取配置后重试一次
   */
  private async callApiWithRetry(
    config: { apiBaseUrl: string; apiKey: string; model: string },
    systemPrompt: string,
    userPrompt: string,
    displayName: string,
    isRetry: boolean = false
  ): Promise<string | null> {
    try {
      const result = await callApi(
        config.apiBaseUrl,
        config.apiKey,
        config.model,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      )
      return result
    } catch (error: any) {
      const errorMessage = error?.message || ''

      // 如果是授权相关错误且不是重试，则清除缓存并重试
      if (!isRetry && (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('无权访问'))) {
        insightLog('WARN', `API 授权失败，清除缓存并重试: ${errorMessage}`)

        // 清除API Key缓存
        clearApiKeyCache()

        // 重新获取配置
        const newConfig = await this.getApiConfig()
        if (!newConfig) {
          insightLog('ERROR', `重试失败：无法获取新的API配置`)
          return null
        }

        insightLog('INFO', `已获取新配置，模型: ${newConfig.model}，开始重试`)

        // 使用新配置重试一次
        return this.callApiWithRetry(
          newConfig,
          systemPrompt,
          userPrompt,
          displayName,
          true // 标记为重试，避免无限循环
        )
      }

      // 其他错误或已经是重试，记录错误并返回null
      insightLog('ERROR', `API 调用失败 (${displayName}): ${errorMessage}`)
      return null
    }
  }

  /**
   * 通过 Telegram Bot API 发送消息。
   * 使用 Node 原生 https 模块，无需第三方依赖。
   */
  private sendTelegram(token: string, chatId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST' as const,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString()
        }
      }
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.ok) {
              resolve()
            } else {
              reject(new Error(parsed.description || '未知错误'))
            }
          } catch {
            reject(new Error(`响应解析失败: ${data.slice(0, 100)}`))
          }
        })
      })
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Telegram 请求超时')) })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

export const insightService = new InsightService()

/**
 * Agent Logger - Agent执行日志系统
 * 日志文件位置: userData/logs/agent/
 */

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

export enum LogStage {
  SESSION_START = 'SESSION_START',
  SESSION_END = 'SESSION_END',
  SYSTEM_PROMPT = 'SYSTEM_PROMPT',
  MESSAGE_HISTORY = 'MESSAGE_HISTORY',
  LLM_REQUEST = 'LLM_REQUEST',
  LLM_RESPONSE_START = 'LLM_RESPONSE_START',
  LLM_STREAM_CHUNK = 'LLM_STREAM_CHUNK',
  LLM_RESPONSE_END = 'LLM_RESPONSE_END',
  LLM_RAW_RESPONSE = 'LLM_RAW_RESPONSE',
  JSON_PARSE_START = 'JSON_PARSE_START',
  JSON_PARSE_SUCCESS = 'JSON_PARSE_SUCCESS',
  JSON_PARSE_ERROR = 'JSON_PARSE_ERROR',
  JSON_FIELD_EXTRACT = 'JSON_FIELD_EXTRACT',
  TOOL_CALL_START = 'TOOL_CALL_START',
  TOOL_CALL_PARAMS = 'TOOL_CALL_PARAMS',
  TOOL_EXEC_START = 'TOOL_EXEC_START',
  TOOL_EXEC_END = 'TOOL_EXEC_END',
  TOOL_EXEC_SUCCESS = 'TOOL_EXEC_SUCCESS',
  TOOL_EXEC_ERROR = 'TOOL_EXEC_ERROR',
  TOOL_RESULT_PREPARE = 'TOOL_RESULT_PREPARE',
  TOOL_RESULT_INJECT = 'TOOL_RESULT_INJECT',
  STATE_TRANSITION = 'STATE_TRANSITION',
  ITERATION_START = 'ITERATION_START',
  ITERATION_END = 'ITERATION_END',
  FINAL_OUTPUT_PREPARE = 'FINAL_OUTPUT_PREPARE',
  FINAL_OUTPUT = 'FINAL_OUTPUT'
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  stage: LogStage
  sessionId: string
  data: any
}

export interface AgentLoggerOptions {
  consoleOutput?: boolean
  fileOutput?: boolean
  minLevel?: LogLevel
}

/**
 * Agent日志记录器
 * 同时输出到控制台和文件
 */
export class AgentLogger {
  private sessionId: string
  private options: AgentLoggerOptions
  private logs: LogEntry[] = []
  private startTime: number
  private logBuffer: string[] = []
  private flushInterval: ReturnType<typeof setInterval> | null = null
  private isFlushing = false
  private ipcAvailable: boolean = false
  private ipcCheckDone: boolean = false
  private flushAttempts: number = 0
  private flushSuccesses: number = 0

  constructor(sessionId: string, options: AgentLoggerOptions = {}) {
    this.sessionId = sessionId
    this.options = {
      consoleOutput: true,
      fileOutput: true,
      minLevel: LogLevel.DEBUG,
      ...options
    }
    this.startTime = Date.now()

    // 检查IPC是否可用
    this.checkIpcAvailability()

    // 启动定时刷新
    if (this.options.fileOutput) {
      this.flushInterval = setInterval(() => {
        this.flushToFile().catch((err) => {
          // 静默处理错误
        })
      }, 3000) // 每3秒刷新一次
    }

    // 记录启动信息
    console.log(`[AgentLogger] 创建Logger实例: sessionId=${sessionId}, ipcAvailable=${this.ipcAvailable}`)
  }

  /**
   * 检查IPC是否可用
   * 每次刷新前都会重新检查，因为electronAPI可能在运行时才初始化
   */
  private checkIpcAvailability(): boolean {
    try {
      const hasWindow = typeof window !== 'undefined'
      const hasElectronAPI = hasWindow && !!window.electronAPI
      const hasAgentAPI = hasElectronAPI && !!window.electronAPI?.agent
      const hasAppendAgentLog = hasAgentAPI && typeof window.electronAPI?.agent?.appendAgentLog === 'function'

      this.ipcAvailable = hasAppendAgentLog

      if (!this.ipcCheckDone) {
        console.log(`[AgentLogger] IPC检查: hasWindow=${hasWindow}, hasElectronAPI=${hasElectronAPI}, hasAgentAPI=${hasAgentAPI}, hasAppendAgentLog=${hasAppendAgentLog}`)
        this.ipcCheckDone = true
      }

      return this.ipcAvailable
    } catch (e) {
      console.error(`[AgentLogger] IPC检查异常:`, e)
      this.ipcAvailable = false
      return false
    }
  }

  /**
   * 记录日志
   */
  log(level: LogLevel, stage: LogStage, data: any): void {
    if (!this.shouldLog(level)) {
      return
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      sessionId: this.sessionId,
      data
    }

    this.logs.push(entry)

    if (this.options.consoleOutput) {
      this.consoleOutput(entry)
    }

    if (this.options.fileOutput) {
      this.bufferForFile(entry)
    }
  }

  debug(stage: LogStage, data: any): void {
    this.log(LogLevel.DEBUG, stage, data)
  }

  info(stage: LogStage, data: any): void {
    this.log(LogLevel.INFO, stage, data)
  }

  warn(stage: LogStage, data: any): void {
    this.log(LogLevel.WARN, stage, data)
  }

  error(stage: LogStage, data: any): void {
    this.log(LogLevel.ERROR, stage, data)
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]
    const minIndex = levels.indexOf(this.options.minLevel!)
    const currentIndex = levels.indexOf(level)
    return currentIndex >= minIndex
  }

  private consoleOutput(entry: LogEntry): void {
    const prefix = `[Agent] [${entry.timestamp}] [${entry.level}] [${entry.stage}]`

    if (entry.level === LogLevel.ERROR) {
      console.error(prefix, entry.data)
    } else if (entry.level === LogLevel.WARN) {
      console.warn(prefix, entry.data)
    } else {
      console.log(prefix, entry.data)
    }
  }

  private bufferForFile(entry: LogEntry): void {
    const logLine = JSON.stringify(entry)
    this.logBuffer.push(logLine)

    // 错误日志立即刷新
    if (entry.level === LogLevel.ERROR) {
      this.flushToFile().catch(() => {})
    }

    // 缓冲区超过50条立即刷新
    if (this.logBuffer.length >= 50) {
      this.flushToFile().catch(() => {})
    }
  }

  /**
   * 刷新日志到文件
   */
  private async flushToFile(): Promise<void> {
    if (this.isFlushing || this.logBuffer.length === 0) return

    this.isFlushing = true
    this.flushAttempts++

    const lines = [...this.logBuffer]
    this.logBuffer = []

    try {
      // 每次刷新前重新检查IPC可用性
      const ipcReady = this.checkIpcAvailability()

      // 尝试使用IPC
      if (ipcReady) {
        try {
          const content = lines.join('\n') + '\n'
          console.log(`[AgentLogger] 尝试写入日志: sessionId=${this.sessionId}, lines=${lines.length}, contentLength=${content.length}`)

          const result = await window.electronAPI!.agent!.appendAgentLog!(this.sessionId, content)

          console.log(`[AgentLogger] IPC调用结果:`, result)

          if (result?.success) {
            this.flushSuccesses++
            console.log(`[AgentLogger] 日志写入成功: attempts=${this.flushAttempts}, successes=${this.flushSuccesses}`)
            this.isFlushing = false
            return
          } else {
            console.error(`[AgentLogger] IPC返回失败:`, result?.error || '未知错误')
            // IPC返回失败，将日志放回缓冲区稍后重试
            this.logBuffer.unshift(...lines)
          }
        } catch (ipcError) {
          console.error(`[AgentLogger] IPC调用异常:`, ipcError)
          // IPC调用异常，将日志放回缓冲区稍后重试
          this.ipcAvailable = false
          this.logBuffer.unshift(...lines)
        }
      } else {
        console.log(`[AgentLogger] IPC不可用，将日志保留在缓冲区稍后重试，当前缓冲区: ${lines.length}条`)
        // IPC不可用，将日志放回缓冲区
        this.logBuffer.unshift(...lines)
      }

      // 限制缓冲区大小（最多保留500条）
      if (this.logBuffer.length > 500) {
        const droppedCount = this.logBuffer.length - 500
        this.logBuffer = this.logBuffer.slice(0, 500)
        console.warn(`[AgentLogger] 缓冲区已满，丢弃最早的 ${droppedCount} 条日志`)
      }
    } catch (e) {
      console.error(`[AgentLogger] flushToFile异常:`, e)
      this.logBuffer.unshift(...lines)
    } finally {
      this.isFlushing = false
    }
  }

  getLogs(): LogEntry[] {
    return [...this.logs]
  }

  getLogsByStage(stage: LogStage): LogEntry[] {
    return this.logs.filter(log => log.stage === stage)
  }

  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logs.filter(log => log.level === level)
  }

  getSessionStats(): {
    sessionId: string
    totalLogs: number
    duration: number
    stages: Record<string, number>
    errorCount: number
  } {
    const stages: Record<string, number> = {}
    let errorCount = 0

    for (const log of this.logs) {
      stages[log.stage] = (stages[log.stage] || 0) + 1
      if (log.level === LogLevel.ERROR) {
        errorCount++
      }
    }

    return {
      sessionId: this.sessionId,
      totalLogs: this.logs.length,
      duration: Date.now() - this.startTime,
      stages,
      errorCount
    }
  }

  exportLogs(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      startTime: new Date(this.startTime).toISOString(),
      endTime: new Date().toISOString(),
      stats: this.getSessionStats(),
      logs: this.logs
    }, null, 2)
  }

  async endSession(): Promise<void> {
    this.info(LogStage.SESSION_END, {
      endTime: new Date().toISOString(),
      totalDuration: Date.now() - this.startTime,
      totalLogs: this.logs.length,
      stats: this.getSessionStats()
    })

    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }

    await this.flushToFile()
  }
}

export function createAgentLogger(sessionId: string, options?: AgentLoggerOptions): AgentLogger {
  return new AgentLogger(sessionId, options)
}

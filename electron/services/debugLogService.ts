import { appendFile, mkdir } from 'fs/promises'
import { existsSync, mkdirSync, appendFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as os from 'os'

/**
 * 调试日志服务 - 用于记录详细的调试信息到文件
 * 避免在软件内显示调试信息，防止被破解利用
 */
class DebugLogService {
  private logDir: string | null = null
  private logFile: string | null = null
  private enabled: boolean = true
  private initialized: boolean = false
  private initError: string | null = null

  private getDefaultLogDir(): string {
    // 使用用户文档目录作为备选，确保日志能写入
    try {
      if (app && app.isReady && app.isReady()) {
        return join(app.getPath('userData'), 'logs')
      }
    } catch (e) {
      // app 未准备好，使用备选路径
    }
    
    // 备选：使用用户文档目录
    const documentsPath = join(os.homedir(), 'Documents', 'ChatFlowLogs')
    return documentsPath
  }

  private ensureInit(): boolean {
    if (this.initialized) return true
    
    try {
      this.logDir = this.getDefaultLogDir()
      this.logFile = join(this.logDir, `debug-${new Date().toISOString().split('T')[0]}.log`)
      
      // 同步创建目录，确保目录存在
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true })
      }
      
      this.initialized = true
      
      // 写入初始化日志
      this.writeSync('INFO', `[DebugLogService] 日志服务初始化成功`)
      this.writeSync('INFO', `[DebugLogService] 日志目录: ${this.logDir}`)
      this.writeSync('INFO', `[DebugLogService] 日志文件: ${this.logFile}`)
      
      return true
    } catch (e) {
      this.initError = String(e)
      // 尝试使用临时目录作为最后的备选
      try {
        this.logDir = join(os.tmpdir(), 'ChatFlowLogs')
        this.logFile = join(this.logDir, `debug-${new Date().toISOString().split('T')[0]}.log`)
        if (!existsSync(this.logDir)) {
          mkdirSync(this.logDir, { recursive: true })
        }
        this.initialized = true
        this.writeSync('INFO', `[DebugLogService] 使用备选日志目录: ${this.logDir}`)
        return true
      } catch (e2) {
        this.initError += `; 备选也失败: ${String(e2)}`
        return false
      }
    }
  }

  private writeSync(level: string, message: string, data?: any): void {
    if (!this.logFile) return
    
    try {
      const timestamp = new Date().toISOString()
      let logLine = `[${timestamp}] [${level}] ${message}`
      if (data !== undefined) {
        try {
          const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)
          logLine += `\n${dataStr}`
        } catch (e) {
          logLine += `\n[无法序列化的数据]`
        }
      }
      logLine += '\n'
      
      appendFileSync(this.logFile, logLine, 'utf8')
    } catch (e) {
      // 静默处理
    }
  }

  private async ensureDir(): Promise<void> {
    if (!this.logDir) return
    if (!existsSync(this.logDir)) {
      await mkdir(this.logDir, { recursive: true })
    }
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString()
    let logLine = `[${timestamp}] [${level}] ${message}`
    if (data !== undefined) {
      try {
        const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)
        logLine += `\n${dataStr}`
      } catch (e) {
        logLine += `\n[无法序列化的数据]`
      }
    }
    return logLine + '\n'
  }

  async log(level: string, message: string, data?: any): Promise<void> {
    if (!this.enabled) return
    
    // 确保初始化
    if (!this.ensureInit()) {
      return
    }

    try {
      await this.ensureDir()
      const logLine = this.formatMessage(level, message, data)
      if (this.logFile) {
        await appendFile(this.logFile, logLine, 'utf8')
      }
    } catch (e) {
      // 如果日志写入失败，静默处理，避免影响主程序
    }
  }

  async debug(message: string, data?: any): Promise<void> {
    await this.log('DEBUG', message, data)
  }

  async info(message: string, data?: any): Promise<void> {
    await this.log('INFO', message, data)
  }

  async warn(message: string, data?: any): Promise<void> {
    await this.log('WARN', message, data)
  }

  async error(message: string, data?: any): Promise<void> {
    await this.log('ERROR', message, data)
  }

  getLogFilePath(): string {
    this.ensureInit()
    return this.logFile || ''
  }

  getLogDir(): string {
    this.ensureInit()
    return this.logDir || ''
  }
  
  getInitError(): string | null {
    return this.initError
  }
}

// 导出单例
export const debugLog = new DebugLogService()

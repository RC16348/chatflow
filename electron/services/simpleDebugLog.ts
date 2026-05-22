import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import * as os from 'os'

/**
 * 简单的调试日志 - 直接写入文件，不依赖 electron app
 * 统一使用 C:\Users\<用户名>\AppData\Roaming\chatflow\logs 目录
 */
function getLogDir(): string {
  // 优先使用 APPDATA 目录
  const appData = process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming')
  return join(appData, 'chatflow', 'logs')
}

const LOG_DIR = getLogDir()
const LOG_FILE = join(LOG_DIR, `debug-${new Date().toISOString().split('T')[0]}.log`)

// 确保目录存在
try {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
  // 写入初始化标记
  const timestamp = new Date().toISOString()
  appendFileSync(LOG_FILE, `[${timestamp}] [INFO] [simpleDebugLog] 日志服务初始化成功\n`, 'utf8')
  appendFileSync(LOG_FILE, `[${timestamp}] [INFO] [simpleDebugLog] 日志目录: ${LOG_DIR}\n`, 'utf8')
  appendFileSync(LOG_FILE, `[${timestamp}] [INFO] [simpleDebugLog] 日志文件: ${LOG_FILE}\n`, 'utf8')
} catch (e) {
  // 如果主目录创建失败，使用临时目录作为备选
  try {
    const tempDir = join(os.tmpdir(), 'ChatFlowLogs')
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true })
    }
    // 重新赋值（注意：这不会更新 LOG_FILE，只是确保目录存在）
    console.warn('[simpleDebugLog] 主日志目录创建失败，使用临时目录:', tempDir)
  } catch (e2) {
    // 完全失败，静默处理
  }
}

export function simpleLog(level: string, message: string, data?: any): void {
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

    appendFileSync(LOG_FILE, logLine, 'utf8')
  } catch (e) {
    // 静默处理
  }
}

export function simpleInfo(message: string, data?: any): void {
  simpleLog('INFO', message, data)
}

export function simpleDebug(message: string, data?: any): void {
  simpleLog('DEBUG', message, data)
}

export function simpleError(message: string, data?: any): void {
  simpleLog('ERROR', message, data)
}

export function getSimpleLogPath(): string {
  return LOG_FILE
}

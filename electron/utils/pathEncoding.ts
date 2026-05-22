import { existsSync } from 'fs'
import { join } from 'path'

// 缓存短路径名，避免重复计算
const shortPathCache = new Map<string, string>()

/**
 * 检查路径是否包含中文字符
 */
export function containsChinese(str: string): boolean {
  return /[\u4e00-\u9fa5]/.test(str)
}

/**
 * 检查路径是否包含非 ASCII 字符
 */
export function containsNonAscii(str: string): boolean {
  return /[^\x00-\x7F]/.test(str)
}

/**
 * 使用 Node.js fs 模块获取真实路径
 * 在某些情况下可以自动转换为短路径名
 */
function getRealPath(longPath: string): string | null {
  try {
    const fs = require('fs')
    // 使用 realpath.native 获取系统级真实路径
    const realPath = fs.realpathSync.native(longPath)
    if (realPath && existsSync(realPath)) {
      return realPath
    }
    return null
  } catch {
    return null
  }
}

/**
 * 获取 Windows 短路径名 (8.3 format)
 * 使用多种方法尝试获取短路径名
 */
function getWindowsShortPath(longPath: string): string | null {
  // 检查缓存
  if (shortPathCache.has(longPath)) {
    return shortPathCache.get(longPath)!
  }

  // 仅在 Windows 平台执行
  if (process.platform !== 'win32') {
    return longPath
  }

  // 首先检查路径是否存在
  if (!existsSync(longPath)) {
    console.warn(`[pathEncoding] 路径不存在: "${longPath}"`)
    return null
  }

  try {
    const { execSync } = require('child_process')
    
    // 方法1: 使用 fs.realpath.native
    const realPath = getRealPath(longPath)
    if (realPath && !containsChinese(realPath) && realPath !== longPath) {
      console.log(`[pathEncoding] 使用 realpath 成功: "${longPath}" -> "${realPath}"`)
      shortPathCache.set(longPath, realPath)
      return realPath
    }

    // 方法2: 使用 cmd 的 for 命令获取短路径名
    // 使用 chcp 65001 设置 UTF-8 编码，避免中文乱码
    try {
      const cmd = `chcp 65001 >nul && for %I in ("${longPath}") do @echo %~sI`
      const result = execSync(cmd, { 
        encoding: 'utf8', 
        shell: 'cmd.exe',
        timeout: 5000
      }).trim()
      
      if (result && result !== longPath && existsSync(result)) {
        console.log(`[pathEncoding] 短路径转换成功: "${longPath}" -> "${result}"`)
        shortPathCache.set(longPath, result)
        return result
      }
    } catch (cmdErr) {
      console.warn(`[pathEncoding] cmd 方法失败: ${cmdErr}`)
    }
    
    // 方法3: 使用 PowerShell 的 Get-ShortPath
    try {
      const psCmd = `powershell.exe -NoProfile -Command "& {$path='${longPath.replace(/'/g, "''")}'; $shortPath = (New-Object -ComObject Scripting.FileSystemObject).GetShortPath($path); Write-Output $shortPath}"`
      const psResult = execSync(psCmd, { 
        encoding: 'utf8',
        timeout: 5000
      }).trim()
      
      if (psResult && psResult !== longPath && existsSync(psResult)) {
        console.log(`[pathEncoding] PowerShell 短路径转换成功: "${longPath}" -> "${psResult}"`)
        shortPathCache.set(longPath, psResult)
        return psResult
      }
    } catch (psErr) {
      console.warn(`[pathEncoding] PowerShell 方法失败: ${psErr}`)
    }

    // 方法4: 使用 WMI 查询短路径名
    try {
      const wmiCmd = `wmic path win32_shortcutfile where "target='${longPath.replace(/\\/g, '\\\\')}'" get target /value`
      // 这个方法比较复杂，暂时跳过
    } catch {
      // 忽略错误
    }
    
    return null
  } catch (error) {
    console.warn(`[pathEncoding] 获取短路径名失败: "${longPath}", 错误: ${error}`)
    return null
  }
}

/**
 * 将路径转换为系统本地编码格式
 * Windows: 尝试使用短路径名 (8.3 format) 绕过中文编码问题
 * macOS/Linux: 保持 UTF-8 不变（这些平台原生支持 UTF-8）
 */
export function toNativePath(utf8Path: string): string {
  if (!utf8Path) return utf8Path

  // macOS 和 Linux 原生支持 UTF-8，直接返回
  if (process.platform !== 'win32') {
    return utf8Path
  }

  // Windows 平台：如果路径不包含非 ASCII 字符，直接返回
  if (!containsNonAscii(utf8Path)) {
    return utf8Path
  }

  // 尝试获取短路径名
  const shortPath = getWindowsShortPath(utf8Path)
  if (shortPath) {
    return shortPath
  }

  // 如果无法获取短路径名，返回原路径并记录警告
  console.error(`[pathEncoding] 严重警告: 无法转换路径为短路径名: "${utf8Path}"`)
  console.error(`[pathEncoding] 这将导致 DLL 调用失败，请确保路径不包含中文或特殊字符`)
  return utf8Path
}

/**
 * 批量转换路径数组
 */
export function toNativePaths(utf8Paths: string[]): string[] {
  return utf8Paths.map(toNativePath)
}

/**
 * 清理路径缓存
 */
export function clearPathCache(): void {
  shortPathCache.clear()
}

/**
 * 获取缓存统计信息（用于调试）
 */
export function getPathCacheStats(): { size: number; keys: string[] } {
  return {
    size: shortPathCache.size,
    keys: Array.from(shortPathCache.keys())
  }
}

/**
 * 测试路径转换（用于调试）
 */
export function testPathConversion(path: string): { 
  original: string; 
  converted: string; 
  success: boolean;
  hasChinese: boolean;
} {
  const hasChinese = containsChinese(path)
  const converted = toNativePath(path)
  const success = !hasChinese || (converted !== path && !containsChinese(converted))
  
  return {
    original: path,
    converted,
    success,
    hasChinese
  }
}

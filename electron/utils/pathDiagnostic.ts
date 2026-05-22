import { existsSync, statSync } from 'fs'
import { toNativePath, containsChinese, testPathConversion, getPathCacheStats, clearPathCache } from './pathEncoding'

/**
 * 路径诊断工具
 * 用于帮助用户排查中文路径相关的问题
 */

export interface PathDiagnosticResult {
  path: string
  exists: boolean
  hasChinese: boolean
  conversionResult: string
  conversionSuccess: boolean
  recommendations: string[]
}

/**
 * 诊断单个路径
 */
export function diagnosePath(path: string): PathDiagnosticResult {
  const recommendations: string[] = []
  
  // 检查路径是否存在
  const exists = existsSync(path)
  if (!exists) {
    recommendations.push('路径不存在，请检查路径是否正确')
  }
  
  // 检查是否包含中文
  const hasChinese = containsChinese(path)
  if (hasChinese) {
    recommendations.push('路径包含中文字符，尝试转换为短路径名')
  }
  
  // 尝试转换
  const conversionResult = toNativePath(path)
  const conversionSuccess = !hasChinese || (conversionResult !== path && !containsChinese(conversionResult))
  
  if (hasChinese && !conversionSuccess) {
    recommendations.push('短路径名转换失败，可能导致 DLL 调用失败')
    recommendations.push('建议：将微信文件迁移到纯英文目录（如 C:\WeChatFiles）')
    recommendations.push('或者启用 Windows 8.3 短文件名支持：fsutil behavior set disable8dot3 0')
  }
  
  if (conversionSuccess && hasChinese) {
    recommendations.push('短路径名转换成功，应该可以正常使用')
  }
  
  return {
    path,
    exists,
    hasChinese,
    conversionResult,
    conversionSuccess,
    recommendations
  }
}

/**
 * 诊断微信数据库路径
 */
export function diagnoseWeChatPath(dbPath: string): {
  dbPath: PathDiagnosticResult
  canConnect: boolean
  overallRecommendation: string
} {
  clearPathCache()
  
  const dbPathResult = diagnosePath(dbPath)
  const canConnect = dbPathResult.exists && (!dbPathResult.hasChinese || dbPathResult.conversionSuccess)
  
  let overallRecommendation = ''
  if (canConnect) {
    overallRecommendation = '✅ 路径诊断通过，应该可以正常连接数据库'
  } else {
    overallRecommendation = '❌ 路径诊断失败，请按照以下建议操作：\n'
    dbPathResult.recommendations.forEach(r => {
      overallRecommendation += `  - ${r}\n`
    })
  }
  
  return {
    dbPath: dbPathResult,
    canConnect,
    overallRecommendation
  }
}

/**
 * 生成诊断报告
 */
export function generateDiagnosticReport(dbPath: string): string {
  const result = diagnoseWeChatPath(dbPath)
  
  let report = '========================================\n'
  report += '    ChatFlow 中文路径诊断报告\n'
  report += '========================================\n\n'
  
  report += `诊断时间: ${new Date().toLocaleString()}\n`
  report += `操作系统: ${process.platform}\n\n`
  
  report += '【路径信息】\n'
  report += `原始路径: ${result.dbPath.path}\n`
  report += `路径存在: ${result.dbPath.exists ? '✅ 是' : '❌ 否'}\n`
  report += `包含中文: ${result.dbPath.hasChinese ? '✅ 是' : '❌ 否'}\n`
  report += `转换结果: ${result.dbPath.conversionResult}\n`
  report += `转换成功: ${result.dbPath.conversionSuccess ? '✅ 是' : '❌ 否'}\n\n`
  
  report += '【建议】\n'
  result.dbPath.recommendations.forEach(r => {
    report += `- ${r}\n`
  })
  report += '\n'
  
  report += '【总体评估】\n'
  report += result.overallRecommendation
  report += '\n\n'
  
  if (!result.canConnect) {
    report += '【解决方案】\n'
    report += '1. 临时方案：将微信文件复制到纯英文目录\n'
    report += '   例如：C:\\WeChatFiles\\wxid_xxx\\Msg\\Multi\\MSG.db\n\n'
    report += '2. 永久方案：启用 Windows 8.3 短文件名支持\n'
    report += '   以管理员身份运行 cmd，执行：\n'
    report += '   fsutil behavior set disable8dot3 0\n'
    report += '   然后重启电脑\n\n'
    report += '3. 迁移方案：修改微信文件存储位置\n'
    report += '   微信设置 -> 文件管理 -> 更改文件保存位置\n'
    report += '   选择一个纯英文路径\n\n'
  }
  
  report += '========================================\n'
  
  return report
}

/**
 * 打印诊断报告到控制台
 */
export function printDiagnosticReport(dbPath: string): void {
  console.log(generateDiagnosticReport(dbPath))
}

// 如果直接运行此文件，执行诊断
if (require.main === module) {
  const dbPath = process.argv[2]
  if (dbPath) {
    printDiagnosticReport(dbPath)
  } else {
    console.log('用法: npx ts-node pathDiagnostic.ts <微信数据库路径>')
    console.log('示例: npx ts-node pathDiagnostic.ts "C:\\Users\\张三\\Documents\\WeChat Files\\wxid_xxx\\Msg\\Multi\\MSG.db"')
  }
}

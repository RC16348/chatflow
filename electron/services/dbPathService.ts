import { join, basename, dirname } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { createDecipheriv } from 'crypto'

export interface WxidInfo {
  wxid: string
  modifiedTime: number
  nickname?: string
  avatarUrl?: string
}

export interface ScanOptions {
  maxDepth: number
  priorityPaths?: string[]
}

export interface ScanProgress {
  stage: 'c-drive' | 'other-drives' | 'completed'
  currentPath: string
  scannedCount: number
  foundCount: number
  percentage: number
}

export type ProgressCallback = (progress: ScanProgress) => void

export class DbPathService {
  // 微信数据库特征目录
  private readonly DB_SIGNATURES = ['db_storage', 'FileStorage/Image', 'FileStorage/Image2']
  // 微信默认目录名
  private readonly WECHAT_DEFAULT_DIRS = ['xwechat_files', 'WeChat Files', '微信文件', 'WeChat']
  // 常见用户数据目录
  private readonly COMMON_USER_DIRS = [
    'Documents', '文档',
    'Downloads', '下载',
    'Desktop', '桌面',
    'AppData/Roaming',
    'AppData/Local',
  ]
  // 白名单路径 - 常见微信安装位置
  private readonly WHITELIST_PATHS = [
    'C:\\Program Files\\Tencent\\WeChat',
    'C:\\Program Files (x86)\\Tencent\\WeChat',
    'C:\\Users\\Public\\Documents\\WeChat',
    'C:\\ProgramData\\Tencent\\WeChat',
  ]
  // 系统目录黑名单
  private readonly BLACKLIST_DIRS = [
    'Windows', 'Program Files', 'Program Files (x86)', '$Recycle.Bin',
    'System Volume Information', 'Config.Msi', 'MSOCache',
    'Recovery', 'Boot', 'inetpub', 'PerfLogs',
    'node_modules', '.git', '.svn', '.hg',
    'Temp', 'tmp', 'cache', 'logs'
  ]

  private readVarint(buf: Buffer, offset: number): { value: number, length: number } {
    let value = 0;
    let length = 0;
    let shift = 0;
    while (offset < buf.length && shift < 32) {
      const b = buf[offset++];
      value |= (b & 0x7f) << shift;
      length++;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return { value, length };
  }

  private extractMmkvString(buf: Buffer, keyName: string): string {
    const keyBuf = Buffer.from(keyName, 'utf8');
    const idx = buf.indexOf(keyBuf);
    if (idx === -1) return '';

    try {
      let offset = idx + keyBuf.length;
      const v1 = this.readVarint(buf, offset);
      offset += v1.length;
      const v2 = this.readVarint(buf, offset);
      offset += v2.length;

      // 合理性检查
      if (v2.value > 0 && v2.value <= 10000 && offset + v2.value <= buf.length) {
        return buf.toString('utf8', offset, offset + v2.value);
      }
    } catch { }
    return '';
  }

  private parseGlobalConfig(rootPath: string): { wxid: string, nickname: string, avatarUrl: string } | null {
    try {
      const configPath = join(rootPath, 'all_users', 'config', 'global_config');
      if (!existsSync(configPath)) return null;

      const fullData = readFileSync(configPath);
      if (fullData.length <= 4) return null;
      const encryptedData = fullData.subarray(4);

      const key = Buffer.alloc(16, 0);
      Buffer.from('xwechat_crypt_key').copy(key);
      const iv = Buffer.alloc(16, 0);

      const decipher = createDecipheriv('aes-128-cfb', key, iv);
      decipher.setAutoPadding(false);
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

      const wxid = this.extractMmkvString(decrypted, 'mmkv_key_user_name');
      const nickname = this.extractMmkvString(decrypted, 'mmkv_key_nick_name');
      let avatarUrl = this.extractMmkvString(decrypted, 'mmkv_key_head_img_url');

      if (!avatarUrl && decrypted.includes('http')) {
        const httpIdx = decrypted.indexOf('http');
        const nullIdx = decrypted.indexOf(0x00, httpIdx);
        if (nullIdx !== -1) {
          avatarUrl = decrypted.toString('utf8', httpIdx, nullIdx);
        }
      }

      if (wxid || nickname) {
        return { wxid, nickname, avatarUrl };
      }
      return null;
    } catch (e) {
      console.error('解析 global_config 失败:', e);
      return null;
    }
  }

  /**
   * 检查目录是否为微信账号目录
   */
  private isAccountDir(entryPath: string): boolean {
    return (
      existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2'))
    )
  }

  /**
   * 检查目录名是否为潜在的账号名
   */
  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    if (lower.startsWith('all') || lower.startsWith('applet') || lower.startsWith('backup') || lower.startsWith('wmpf')) {
      return false
    }
    return true
  }

  /**
   * 检查目录是否为微信数据根目录（多维度识别）
   */
  private isWechatRootDir(dirPath: string): { isValid: boolean; confidence: number; accountCount: number } {
    try {
      const entries = readdirSync(dirPath)
      let accountCount = 0
      let hasAllUsers = false
      let hasApplet = false
      let hasConfig = false

      for (const entry of entries) {
        const lower = entry.toLowerCase()
        
        // 检查 all_users 目录
        if (lower === 'all_users') {
          hasAllUsers = true
          // 检查是否有 config 目录
          if (existsSync(join(dirPath, entry, 'config'))) {
            hasConfig = true
          }
          continue
        }
        
        // 检查 applet 目录
        if (lower === 'applet' || lower.startsWith('applet_')) {
          hasApplet = true
          continue
        }

        if (!this.isPotentialAccountName(entry)) continue
        const entryPath = join(dirPath, entry)
        try {
          const stat = statSync(entryPath)
          if (stat.isDirectory() && this.isAccountDir(entryPath)) {
            accountCount++
          }
        } catch { }
      }

      // 计算置信度
      let confidence = 0
      if (accountCount > 0) confidence += 50
      if (hasAllUsers) confidence += 25
      if (hasApplet) confidence += 15
      if (hasConfig) confidence += 10

      return { 
        isValid: accountCount > 0 || (hasAllUsers && hasApplet), 
        confidence,
        accountCount 
      }
    } catch { }
    return { isValid: false, confidence: 0, accountCount: 0 }
  }

  /**
   * 检查是否应该跳过该目录
   */
  private shouldSkipDir(dirName: string): boolean {
    // 隐藏目录
    if (dirName.startsWith('.') || dirName.startsWith('$')) return true
    // 系统目录黑名单
    const lower = dirName.toLowerCase()
    if (this.BLACKLIST_DIRS.some(d => lower === d.toLowerCase())) return true
    return false
  }

  /**
   * 深度扫描目录查找微信数据库（异步版本，支持进度回调）
   * @param startPath 起始路径
   * @param maxDepth 最大扫描深度
   * @param currentDepth 当前深度
   * @param foundPaths 已找到的路径集合（用于去重）
   * @param progress 进度统计对象
   * @param onProgress 进度回调函数
   * @returns 找到的有效路径数组
   */
  private async deepScanForWechatAsync(
    startPath: string,
    maxDepth: number,
    currentDepth: number = 0,
    foundPaths: Set<string> = new Set(),
    progress: { scanned: number; found: number; stage: ScanProgress['stage'] } = { scanned: 0, found: 0, stage: 'c-drive' },
    onProgress?: ProgressCallback
  ): Promise<string[]> {
    const results: string[] = []

    if (currentDepth > maxDepth) return results

    try {
      // 更新进度
      progress.scanned++
      if (onProgress && progress.scanned % 10 === 0) {
        onProgress({
          stage: progress.stage,
          currentPath: startPath,
          scannedCount: progress.scanned,
          foundCount: progress.found,
          percentage: Math.min(100, Math.round((progress.scanned / 1000) * 100))
        })
      }

      // 检查当前目录本身是否是微信根目录
      const rootCheck = this.isWechatRootDir(startPath)
      if (rootCheck.isValid && rootCheck.confidence >= 50) {
        if (!foundPaths.has(startPath)) {
          foundPaths.add(startPath)
          results.push(startPath)
          progress.found++
        }
        return results
      }

      // 检查是否是微信默认目录
      const dirName = basename(startPath).toLowerCase()
      if (this.WECHAT_DEFAULT_DIRS.some(d => dirName.includes(d.toLowerCase()))) {
        const check = this.isWechatRootDir(startPath)
        if (check.isValid) {
          if (!foundPaths.has(startPath)) {
            foundPaths.add(startPath)
            results.push(startPath)
            progress.found++
          }
          return results
        }
      }

      // 扫描子目录
      const entries = readdirSync(startPath)
      
      // 分批处理，避免阻塞
      const batchSize = 50
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize)
        
        for (const entry of batch) {
          // 跳过不应该扫描的目录
          if (this.shouldSkipDir(entry)) continue

          const entryPath = join(startPath, entry)
          try {
            const stat = statSync(entryPath)
            if (!stat.isDirectory()) continue

            // 如果是微信默认目录，优先检查
            const entryLower = entry.toLowerCase()
            if (this.WECHAT_DEFAULT_DIRS.some(d => entryLower.includes(d.toLowerCase()))) {
              const check = this.isWechatRootDir(entryPath)
              if (check.isValid) {
                if (!foundPaths.has(entryPath)) {
                  foundPaths.add(entryPath)
                  results.push(entryPath)
                  progress.found++
                }
                continue
              }
            }

            // 递归扫描子目录
            const subResults = await this.deepScanForWechatAsync(
              entryPath, 
              maxDepth, 
              currentDepth + 1, 
              foundPaths,
              progress,
              onProgress
            )
            results.push(...subResults)
          } catch { }
        }
        
        // 让出事件循环
        await new Promise(resolve => setImmediate(resolve))
      }
    } catch { }

    return results
  }

  /**
   * 获取扫描起始路径列表（优化版本）
   */
  private getScanStartPaths(): { cDrive: string[]; otherDrives: string[]; whitelist: string[] } {
    const cDrive: string[] = []
    const otherDrives: string[] = []
    const whitelist: string[] = []
    const home = homedir()

    if (process.platform === 'darwin') {
      // macOS 优先路径
      cDrive.push(
        join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat'),
        join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents'),
        join(home, 'Documents'),
        join(home, 'Downloads'),
        join(home, 'Desktop')
      )
    } else {
      // Windows 优先路径 - C盘常用位置
      cDrive.push(
        join(home, 'Documents'),
        join(home, 'Documents', 'xwechat_files'),
        join(home, 'Downloads'),
        join(home, 'Desktop'),
        'C:\\Users'
      )

      // 添加白名单路径（如果存在）
      for (const path of this.WHITELIST_PATHS) {
        if (existsSync(path)) {
          whitelist.push(path)
        }
      }

      // 添加其他盘符
      for (let i = 68; i <= 90; i++) { // D: to Z:
        const drive = String.fromCharCode(i) + ':\\'
        if (existsSync(drive)) {
          otherDrives.push(drive)
        }
      }
    }

    return {
      cDrive: cDrive.filter(p => existsSync(p)),
      otherDrives: otherDrives.filter(p => existsSync(p)),
      whitelist: whitelist.filter(p => existsSync(p))
    }
  }

  /**
   * 验证路径是否有效（检查文件夹存在性和修改时间）
   * 超过90天未修改的路径会被视为无效，继续查找其他路径
   */
  private validatePath(path: string): { valid: boolean; reason?: string; modifiedTime?: number } {
    try {
      if (!existsSync(path)) {
        return { valid: false, reason: '路径不存在' }
      }

      const stat = statSync(path)
      if (!stat.isDirectory()) {
        return { valid: false, reason: '不是目录' }
      }

      // 检查是否有账号目录
      const entries = readdirSync(path)
      let hasValidAccount = false
      let latestModifiedTime = 0

      for (const entry of entries) {
        if (!this.isPotentialAccountName(entry)) continue
        
        const entryPath = join(path, entry)
        try {
          const entryStat = statSync(entryPath)
          if (entryStat.isDirectory()) {
            // 检查是否是有效的账号目录
            if (this.isAccountDir(entryPath)) {
              hasValidAccount = true
              if (entryStat.mtimeMs > latestModifiedTime) {
                latestModifiedTime = entryStat.mtimeMs
              }
            }
          }
        } catch { }
      }

      if (!hasValidAccount) {
        return { valid: false, reason: '未找到有效的微信账号目录' }
      }

      // 检查修改时间（超过90天未修改的视为无效，继续查找其他路径）
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000
      if (latestModifiedTime < ninetyDaysAgo) {
        console.log(`[ChatFlow] 路径 ${path} 数据超过90天未更新，跳过`)
        return { valid: false, reason: '数据超过90天未更新，跳过' }
      }

      return { valid: true, modifiedTime: latestModifiedTime }
    } catch (e) {
      return { valid: false, reason: `验证失败: ${e}` }
    }
  }

  /**
   * 智能全盘扫描微信数据库目录（优化版本）
   * C盘深度6，其他盘深度3，找到第一个结果立即停止
   * 并进行有效性验证
   */
  async autoDetect(onProgress?: ProgressCallback): Promise<{ 
    success: boolean; 
    path?: string; 
    error?: string;
    warning?: string;
  }> {
    try {
      const { cDrive, otherDrives, whitelist } = this.getScanStartPaths()
      const foundPaths: Set<string> = new Set()

      // 第一步：扫描白名单路径（深度8，最高优先级）
      if (whitelist.length > 0) {
        console.log('[ChatFlow] 开始扫描白名单路径，深度8...')
        const progress = { scanned: 0, found: 0, stage: 'c-drive' as const }
        
        for (const startPath of whitelist) {
          try {
            const results = await this.deepScanForWechatAsync(startPath, 8, 0, foundPaths, progress, onProgress)
            if (results.length > 0) {
              const path = results[0]
              // 验证路径有效性
              const validation = this.validatePath(path)
              if (validation.valid) {
                const check = this.isWechatRootDir(path)
                console.log(`[ChatFlow] 在白名单路径找到: ${path}, 账号数: ${check.accountCount}`)
                return { 
                  success: true, 
                  path,
                  warning: validation.reason
                }
              } else {
                console.log(`[ChatFlow] 路径验证失败 ${path}: ${validation.reason}`)
              }
            }
          } catch (e) {
            console.error(`[ChatFlow] 扫描白名单路径失败 ${startPath}:`, e)
          }
        }
      }

      // 第二步：优先扫描C盘，深度6
      console.log('[ChatFlow] 开始扫描C盘常用目录，深度6...')
      const cProgress = { scanned: 0, found: 0, stage: 'c-drive' as const }
      
      for (const startPath of cDrive) {
        try {
          const results = await this.deepScanForWechatAsync(startPath, 6, 0, foundPaths, cProgress, onProgress)
          if (results.length > 0) {
            const path = results[0]
            // 验证路径有效性
            const validation = this.validatePath(path)
            if (validation.valid) {
              const check = this.isWechatRootDir(path)
              console.log(`[ChatFlow] 在C盘找到: ${path}, 账号数: ${check.accountCount}`)
              return { 
                success: true, 
                path,
                warning: validation.reason
              }
            } else {
              console.log(`[ChatFlow] 路径验证失败 ${path}: ${validation.reason}`)
            }
          }
        } catch (e) {
          console.error(`[ChatFlow] 扫描C盘路径失败 ${startPath}:`, e)
        }
      }

      // 第三步：如果C盘和白名单没找到，扫描其他盘，深度3
      console.log('[ChatFlow] C盘和白名单未找到，开始扫描其他盘，深度3...')
      const otherProgress = { scanned: 0, found: 0, stage: 'other-drives' as const }
      
      for (const startPath of otherDrives) {
        try {
          const results = await this.deepScanForWechatAsync(startPath, 3, 0, foundPaths, otherProgress, onProgress)
          if (results.length > 0) {
            const path = results[0]
            // 验证路径有效性
            const validation = this.validatePath(path)
            if (validation.valid) {
              const check = this.isWechatRootDir(path)
              console.log(`[ChatFlow] 在其他盘找到: ${path}, 账号数: ${check.accountCount}`)
              return { 
                success: true, 
                path,
                warning: validation.reason
              }
            } else {
              console.log(`[ChatFlow] 路径验证失败 ${path}: ${validation.reason}`)
            }
          }
        } catch (e) {
          console.error(`[ChatFlow] 扫描其他盘路径失败 ${startPath}:`, e)
        }
      }

      // 通知完成
      if (onProgress) {
        onProgress({
          stage: 'completed',
          currentPath: '',
          scannedCount: cProgress.scanned + otherProgress.scanned,
          foundCount: 0,
          percentage: 100
        })
      }

      return { 
        success: false, 
        error: '未能自动检测到微信数据库目录，请手动选择'
      }
    } catch (e) {
      console.error('[ChatFlow] 自动检测失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 查找账号目录（包含 db_storage 或图片目录）
   */
  findAccountDirs(rootPath: string): string[] {
    const accounts: string[] = []

    try {
      const entries = readdirSync(rootPath)

      for (const entry of entries) {
        const entryPath = join(rootPath, entry)
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(entryPath)
        } catch {
          continue
        }

        if (stat.isDirectory()) {
          if (!this.isPotentialAccountName(entry)) continue

          // 检查是否有有效账号目录结构
          if (this.isAccountDir(entryPath)) {
            accounts.push(entry)
          }
        }
      }
    } catch { }

    return accounts
  }

  private getAccountModifiedTime(entryPath: string): number {
    try {
      const accountStat = statSync(entryPath)
      let latest = accountStat.mtimeMs

      const dbPath = join(entryPath, 'db_storage')
      if (existsSync(dbPath)) {
        const dbStat = statSync(dbPath)
        latest = Math.max(latest, dbStat.mtimeMs)
      }

      const imagePath = join(entryPath, 'FileStorage', 'Image')
      if (existsSync(imagePath)) {
        const imageStat = statSync(imagePath)
        latest = Math.max(latest, imageStat.mtimeMs)
      }

      const image2Path = join(entryPath, 'FileStorage', 'Image2')
      if (existsSync(image2Path)) {
        const image2Stat = statSync(image2Path)
        latest = Math.max(latest, image2Stat.mtimeMs)
      }

      return latest
    } catch {
      return 0
    }
  }

  /**
   * 扫描目录名候选（仅包含下划线的文件夹，排除 all_users）
   */
  scanWxidCandidates(rootPath: string): WxidInfo[] {
    const wxids: WxidInfo[] = []

    try {
      if (existsSync(rootPath)) {
        const entries = readdirSync(rootPath)
        for (const entry of entries) {
          const entryPath = join(rootPath, entry)
          let stat: ReturnType<typeof statSync>
          try { stat = statSync(entryPath) } catch { continue }
          if (!stat.isDirectory()) continue
          const lower = entry.toLowerCase()
          if (lower === 'all_users') continue
          if (!entry.includes('_')) continue
          wxids.push({ wxid: entry, modifiedTime: stat.mtimeMs })
        }
      }


      if (wxids.length === 0) {
        const rootName = basename(rootPath)
        if (rootName.includes('_') && rootName.toLowerCase() !== 'all_users') {
          const rootStat = statSync(rootPath)
          wxids.push({ wxid: rootName, modifiedTime: rootStat.mtimeMs })
        }
      }
    } catch { }

    const sorted = wxids.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    });

    const globalInfo = this.parseGlobalConfig(rootPath);
    if (globalInfo) {
      for (const w of sorted) {
        if (w.wxid.startsWith(globalInfo.wxid) || sorted.length === 1) {
          w.nickname = globalInfo.nickname;
          w.avatarUrl = globalInfo.avatarUrl;
        }
      }
    }

    return sorted;
  }


  /**
   * 扫描 wxid 列表
   */
  scanWxids(rootPath: string): WxidInfo[] {
    const wxids: WxidInfo[] = []

    try {
      if (this.isAccountDir(rootPath)) {
        const wxid = basename(rootPath)
        const modifiedTime = this.getAccountModifiedTime(rootPath)
        return [{ wxid, modifiedTime }]
      }

      const accounts = this.findAccountDirs(rootPath)

      for (const account of accounts) {
        const fullPath = join(rootPath, account)
        const modifiedTime = this.getAccountModifiedTime(fullPath)
        wxids.push({ wxid: account, modifiedTime })
      }
    } catch { }

    const sorted = wxids.sort((a, b) => {
      if (b.modifiedTime !== a.modifiedTime) return b.modifiedTime - a.modifiedTime
      return a.wxid.localeCompare(b.wxid)
    });

    const globalInfo = this.parseGlobalConfig(rootPath);
    if (globalInfo) {
      for (const w of sorted) {
        if (w.wxid.startsWith(globalInfo.wxid) || sorted.length === 1) {
          w.nickname = globalInfo.nickname;
          w.avatarUrl = globalInfo.avatarUrl;
        }
      }
    }
    return sorted;
  }

  /**
   * 获取默认数据库路径
   */
  getDefaultPath(): string {
    const home = homedir()
    if (process.platform === 'darwin') {
      // 优先返回 4.0.5+ 新路径
      const appSupportBase = join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Library', 'Application Support', 'com.tencent.xinWeChat')
      if (existsSync(appSupportBase)) {
        try {
          const entries = readdirSync(appSupportBase)
          for (const entry of entries) {
            if (/^\d+\.\d+b\d+\.\d+/.test(entry) || /^\d+\.\d+\.\d+/.test(entry)) {
              const candidate = join(appSupportBase, entry)
              if (existsSync(candidate)) return candidate
            }
          }
        } catch { }
      }
      // 旧版本路径兜底
      return join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
    }
    return join(home, 'Documents', 'xwechat_files')
  }
}

export const dbPathService = new DbPathService()

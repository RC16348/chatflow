import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import JSZip from 'jszip'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import { getSkillAnalysisService, AnalysisInput, AnalysisResult } from './skillAnalysisService'
import { ConfigService } from './config'

/**
 * 导出选项
 */
export interface SkillExportOptions {
  contactId: string
  timeRange: '1month' | '3months' | '6months' | 'all'
  includeVoiceText: boolean
  anonymize: boolean
  format: 'openclaw' | 'claude_code' | 'generic'
}

/**
 * 导出结果
 */
export interface SkillExportResult {
  success: boolean
  filePath?: string
  error?: string
  analysisData?: any
}

/**
 * 消息数据结构
 */
interface MessageData {
  id: string
  sender: string
  content: string
  timestamp: number
  type: number
}

/**
 * 分析数据结构
 */
interface AnalysisData {
  totalMessages: number
  senderStats: Record<string, number>
  timeDistribution: Record<string, number>
  keyTopics: string[]
  emotionTrend: string
}

/**
 * SKILL导出服务
 * 用于导出聊天记录为SKILL格式，供AI助手训练使用
 */
class SkillExportService {
  /**
   * 导出SKILL
   * @param options 导出选项
   * @returns 导出结果
   */
  async exportSkill(options: SkillExportOptions): Promise<SkillExportResult> {
    return new Promise((resolve) => {
      // 使用 setImmediate 将导出逻辑放入事件循环，避免阻塞主进程
      setImmediate(async () => {
        try {
          // 验证参数
          if (!options.contactId) {
            resolve({ success: false, error: '联系人ID不能为空' })
            return
          }

          // 获取联系人信息
          const contactInfo = await this.getContactDisplayName(options.contactId)
          if (!contactInfo) {
            resolve({ success: false, error: '获取联系人信息失败' })
            return
          }

          // 让出事件循环
          await new Promise(r => setTimeout(r, 0))

          const { displayName, nickname } = contactInfo
          const safeName = this.sanitizeFileName(displayName || nickname || options.contactId)

          // 计算时间范围
          const { startTime, endTime } = this.calculateTimeRange(options.timeRange)

          // 获取聊天记录
          const messagesResult = await this.fetchMessages(options.contactId, startTime, endTime, options.includeVoiceText)
          if (!messagesResult.success) {
            resolve({ success: false, error: messagesResult.error || '获取聊天记录失败' })
            return
          }

          const messages = messagesResult.messages || []
          if (messages.length === 0) {
            resolve({ success: false, error: '该时间范围内没有聊天记录' })
            return
          }

          // 让出事件循环
          await new Promise(r => setTimeout(r, 0))

          // 准备 AI 分析输入数据
          const analysisInput = await this.prepareAnalysisInput(
            options.contactId,
            messages,
            options.anonymize
          )

          // 使用 AI 进行深度分析
          let aiAnalysisResult: AnalysisResult | null = null
          try {
            const analysisService = getSkillAnalysisService()
            aiAnalysisResult = await analysisService.analyze(
              analysisInput.messages,
              analysisInput.user,
              analysisInput.contact,
              (progress, stage) => {
                console.log(`[SkillExportService] AI 分析进度: ${progress}% - ${stage}`)
              }
            )
          } catch (error) {
            console.error('[SkillExportService] AI 分析失败，使用基础分析:', error)
            // AI 分析失败时，继续使用基础分析
          }

          // 让出事件循环
          await new Promise(r => setTimeout(r, 0))

          // 进行基础数据分析（作为后备）
          const baseAnalysisData = this.analyzeMessages(messages, options.anonymize)

          // 让出事件循环
          await new Promise(r => setTimeout(r, 0))

          // 生成ZIP文件
          const zipFilePath = await this.generateZipFile(
            safeName,
            messages,
            baseAnalysisData,
            options,
            displayName || nickname || options.contactId,
            aiAnalysisResult
          )

          resolve({
            success: true,
            filePath: zipFilePath,
            analysisData: {
              base: baseAnalysisData,
              ai: aiAnalysisResult
            }
          })
        } catch (error) {
          console.error('[SkillExportService] 导出失败:', error)
          resolve({
            success: false,
            error: `导出失败: ${error instanceof Error ? error.message : String(error)}`
          })
        }
      })
    })
  }

  /**
   * 获取联系人显示名称
   */
  private async getContactDisplayName(contactId: string): Promise<{ displayName: string; nickname: string } | null> {
    try {
      const contact = await chatService.getContact(contactId)
      if (!contact) {
        return null
      }
      // Contact 对象的实际字段是 remark, nickName, alias, username
      const rawRemark = this.getValidString(contact.remark)
      const rawNickName = this.getValidString((contact as any).nickName)
      const rawAlias = this.getValidString(contact.alias)

      console.log('[SkillExportService] 联系人原始数据:', JSON.stringify({
        remark: contact.remark,
        nickName: (contact as any).nickName,
        alias: contact.alias,
        username: contact.username,
        allKeys: Object.keys(contact)
      }))

      const isWxid = (s: string) => s && (s.startsWith('wxid_') || s.startsWith('Wxid_'))

      // displayName 用于文件名：优先备注名 → 昵称 → 别名
      let displayName = rawRemark || rawNickName || rawAlias
      // nickname 用于显示
      let nickname = rawNickName || rawRemark || rawAlias

      if (!displayName || isWxid(displayName)) {
        displayName = (rawNickName && !isWxid(rawNickName)) ? rawNickName : 
                     (rawAlias && !isWxid(rawAlias)) ? rawAlias : '微信好友'
      }
      if (!nickname || isWxid(nickname)) {
        nickname = displayName
      }

      console.log('[SkillExportService] 解析后的名称:', { displayName, nickname })

      return { displayName, nickname }
    } catch (error) {
      console.error('[SkillExportService] 获取联系人信息失败:', error)
      return null
    }
  }

  /**
   * 计算时间范围
   */
  private calculateTimeRange(timeRange: string): { startTime: number; endTime: number } {
    const now = Date.now()
    const endTime = now
    let startTime = 0

    switch (timeRange) {
      case '1month':
        startTime = now - 30 * 24 * 60 * 60 * 1000
        break
      case '3months':
        startTime = now - 90 * 24 * 60 * 60 * 1000
        break
      case '6months':
        startTime = now - 180 * 24 * 60 * 60 * 1000
        break
      case 'all':
        startTime = 0
        break
      default:
        startTime = now - 90 * 24 * 60 * 60 * 1000
    }

    // 转换为秒（微信数据库使用秒级时间戳）
    return {
      startTime: Math.floor(startTime / 1000),
      endTime: Math.floor(endTime / 1000)
    }
  }

  /**
   * 获取聊天记录
   */
  private async fetchMessages(
    contactId: string,
    startTime: number,
    endTime: number,
    includeVoiceText: boolean
  ): Promise<{ success: boolean; messages?: MessageData[]; error?: string }> {
    try {
      const messages: MessageData[] = []
      let offset = 0
      const batchSize = 500
      let hasMore = true

      while (hasMore) {
        const result = await chatService.getMessages(
          contactId,
          offset,
          batchSize,
          startTime,
          endTime,
          true // ascending
        )

        if (!result.success) {
          return { success: false, error: result.error }
        }

        const batchMessages = result.messages || []
        if (batchMessages.length === 0) {
          break
        }

        for (const msg of batchMessages) {
          const content = this.extractMessageContent(msg, includeVoiceText)
          if (content) {
            messages.push({
              id: msg.messageKey || String(msg.localId),
              sender: msg.senderUsername || '',
              content,
              timestamp: msg.createTime * 1000, // 转换为毫秒
              type: msg.localType
            })
          }
        }

        offset += batchMessages.length
        hasMore = result.hasMore || false

        // 限制最大消息数量，防止内存溢出
        if (messages.length >= 50000) {
          console.warn('[SkillExportService] 消息数量超过限制，截断处理')
          break
        }
      }

      return { success: true, messages }
    } catch (error) {
      console.error('[SkillExportService] 获取消息失败:', error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * 提取消息内容
   */
  private extractMessageContent(msg: any, includeVoiceText: boolean): string {
    const type = msg.localType

    switch (type) {
      case 1: // 文本
        return msg.parsedContent || ''
      case 3: // 图片
        return '[图片]'
      case 34: // 语音
        if (includeVoiceText && msg.parsedContent && msg.parsedContent !== '[语音]') {
          return `[语音] ${msg.parsedContent}`
        }
        return '[语音]'
      case 43: // 视频
        return '[视频]'
      case 47: // 表情
        return '[表情]'
      case 49: // 链接/文件/小程序等
        if (msg.linkTitle) {
          return `[链接] ${msg.linkTitle}${msg.linkUrl ? ` - ${msg.linkUrl}` : ''}`
        }
        if (msg.fileName) {
          return `[文件] ${msg.fileName}`
        }
        return '[应用消息]'
      case 10000: // 系统消息
        return `[系统] ${msg.parsedContent || ''}`
      default:
        return msg.parsedContent || '[未知消息]'
    }
  }

  /**
   * 分析消息数据
   */
  private analyzeMessages(messages: MessageData[], anonymize: boolean): AnalysisData {
    const senderStats: Record<string, number> = {}
    const timeDistribution: Record<string, number> = {}
    const wordFreq: Record<string, number> = {}

    for (const msg of messages) {
      // 统计发送者
      const sender = anonymize ? this.anonymizeName(msg.sender) : msg.sender
      senderStats[sender] = (senderStats[sender] || 0) + 1

      // 时间分布（按小时）
      const hour = new Date(msg.timestamp).getHours()
      const timeKey = `${hour}:00-${hour}:59`
      timeDistribution[timeKey] = (timeDistribution[timeKey] || 0) + 1

      // 词频统计（简单实现）
      const words = msg.content.split(/\s+/)
      for (const word of words) {
        const cleanWord = word.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
        if (cleanWord.length >= 2 && cleanWord.length <= 10) {
          wordFreq[cleanWord] = (wordFreq[cleanWord] || 0) + 1
        }
      }
    }

    // 提取关键词
    const keyTopics = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word]) => word)

    // 情感趋势（简单判断）
    const positiveWords = ['好', '棒', '开心', '喜欢', '爱', '哈哈', '谢谢', '不错']
    const negativeWords = ['差', '糟', '难过', '讨厌', '恨', '呜呜', '抱歉', '不好']

    let positiveCount = 0
    let negativeCount = 0

    for (const msg of messages) {
      const content = msg.content
      for (const word of positiveWords) {
        if (content.includes(word)) positiveCount++
      }
      for (const word of negativeWords) {
        if (content.includes(word)) negativeCount++
      }
    }

    let emotionTrend = '中性'
    if (positiveCount > negativeCount * 2) {
      emotionTrend = '积极'
    } else if (negativeCount > positiveCount * 2) {
      emotionTrend = '消极'
    }

    return {
      totalMessages: messages.length,
      senderStats,
      timeDistribution,
      keyTopics,
      emotionTrend
    }
  }

  /**
   * 匿名化处理
   */
  private anonymizeName(name: string): string {
    if (!name) return '未知'
    if (name.length <= 2) return name[0] + '*'
    return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1]
  }

  /**
   * 准备 AI 分析输入数据
   */
  private async prepareAnalysisInput(
    contactId: string,
    messages: MessageData[],
    anonymize: boolean
  ): Promise<AnalysisInput> {
    // 获取联系人信息
    const contact = await chatService.getContact(contactId)
    
    // 获取当前用户信息（从配置中读取）
    const configService = ConfigService.getInstance()
    const selfUsername = configService.get('myWxid') || 'user'
    const selfNickname = '我'
    
    // 准备消息数据
    const messageItems = messages.map(msg => ({
      timestamp: msg.timestamp,
      sender: msg.sender === selfUsername ? 'user' : 'contact' as 'user' | 'contact',
      senderName: anonymize ? this.anonymizeName(msg.sender) : msg.sender,
      type: this.getMessageTypeName(msg.type),
      content: msg.content
    }))

    // 计算统计数据
    const userMessages = messageItems.filter(m => m.sender === 'user')
    const contactMessages = messageItems.filter(m => m.sender === 'contact')
    
    // 按日期统计聊天频率
    const dateCount: Record<string, number> = {}
    for (const msg of messageItems) {
      const date = new Date(msg.timestamp).toISOString().split('T')[0]
      dateCount[date] = (dateCount[date] || 0) + 1
    }
    
    // 按小时统计活跃时段
    const hourCount: Record<number, number> = {}
    for (const msg of messageItems) {
      const hour = new Date(msg.timestamp).getHours()
      hourCount[hour] = (hourCount[hour] || 0) + 1
    }

    // 统计消息类型
    const typeCount: Record<string, number> = {}
    for (const msg of messageItems) {
      typeCount[msg.type] = (typeCount[msg.type] || 0) + 1
    }

    return {
      user: {
        nickname: selfNickname,
        remark: undefined,
        gender: undefined,
        region: undefined
      },
      contact: {
        nickname: contact?.nickname || contactId,
        remark: contact?.remark,
        alias: contact?.alias,
        gender: contact?.gender,
        region: contact?.region,
        labels: contact?.labels
      },
      messages: messageItems,
      stats: {
        messageCount: {
          user: userMessages.length,
          contact: contactMessages.length
        },
        chatFrequency: Object.entries(dateCount).map(([date, count]) => ({ date, count })),
        activeHours: Object.entries(hourCount).map(([hour, count]) => ({ hour: Number(hour), count })),
        messageTypes: typeCount
      }
    }
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(type: number): string {
    const typeMap: Record<number, string> = {
      1: 'text',
      3: 'image',
      34: 'voice',
      43: 'video',
      47: 'emoji',
      49: 'link',
      10000: 'system'
    }
    return typeMap[type] || 'unknown'
  }

  /**
   * 生成ZIP文件
   */
  private async generateZipFile(
    safeName: string,
    messages: MessageData[],
    analysisData: AnalysisData,
    options: SkillExportOptions,
    originalName: string,
    aiAnalysisResult?: AnalysisResult | null
  ): Promise<string> {
    const zip = new JSZip()
    const folderName = `${safeName}.SKILL`
    const rootFolder = zip.folder(folderName)

    if (!rootFolder) {
      throw new Error('创建ZIP文件夹失败')
    }

    // 生成SKILL.md（使用 AI 分析结果）
    const skillMd = this.generateSkillMd(messages, analysisData, options, originalName, aiAnalysisResult)
    rootFolder.file('SKILL.md', skillMd)

    // 生成README.md
    const readmeMd = this.generateReadmeMd(originalName, analysisData, options)
    rootFolder.file('README.md', readmeMd)

    // 生成metadata.json
    const metadata = this.generateMetadata(originalName, messages.length, options)
    rootFolder.file('metadata.json', JSON.stringify(metadata, null, 2))

    // 创建references文件夹
    const referencesFolder = rootFolder.folder('references')
    if (referencesFolder) {
      // 分析报告
      const analysisReport = this.generateAnalysisReport(analysisData, originalName)
      referencesFolder.file('analysis_report.md', analysisReport)

      // 关键引用
      const keyQuotes = this.generateKeyQuotes(messages, options.anonymize)
      referencesFolder.file('key_quotes.json', JSON.stringify(keyQuotes, null, 2))

      // 情感地图
      const emotionMap = this.generateEmotionMap(analysisData)
      referencesFolder.file('emotion_map.json', JSON.stringify(emotionMap, null, 2))
    }

    // 生成ZIP文件
    const zipContent = await zip.generateAsync({ type: 'nodebuffer' })

    // 保存到下载目录
    const downloadsPath = app.getPath('downloads')
    const zipFileName = `${safeName}.SKILL.zip`
    const zipFilePath = path.join(downloadsPath, zipFileName)

    // 使用异步写入避免阻塞主进程
await fsp.writeFile(zipFilePath, zipContent)

    return zipFilePath
  }

  /**
   * 生成SKILL.md内容
   */
  private generateSkillMd(
    messages: MessageData[],
    analysisData: AnalysisData,
    options: SkillExportOptions,
    contactName: string,
    aiAnalysisResult?: AnalysisResult | null
  ): string {
    const lines: string[] = []

    // 如果有 AI 分析结果，使用 AI 生成的内容
    if (aiAnalysisResult) {
      return this.generateAiSkillMd(contactName, aiAnalysisResult, options, messages, analysisData)
    }

    // 否则使用基础分析内容（与 AI 版本模板结构对齐）
    const safeName = contactName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
    const timeRange = this.formatTimeRange(options.timeRange)
    const exportTime = new Date().toLocaleString('zh-CN')

    // ─── Frontmatter ──────────────────────────────────────────────
    lines.push('---')
    lines.push(`name: ${safeName}-perspective`)
    lines.push('description: |')
    lines.push(`  ${contactName}的聊天风格分析。基于${timeRange}的微信聊天记录统计，`)
    lines.push('  包含消息频率、活跃时段、关键词和情感倾向等基础特征。')
    lines.push(`  用途：作为参考，了解${contactName}的基本聊天习惯。`)
    lines.push('---')
    lines.push('')

    // ─── 标题 ─────────────────────────────────────────────────────
    lines.push(`# ${contactName} · 聊天风格概览`)
    lines.push('')

    // ─── 角色扮演规则 ─────────────────────────────────────────────
    lines.push('## 角色扮演规则（最重要）')
    lines.push('')
    lines.push(`**此Skill激活后，直接以${contactName}的身份回应。**`)
    lines.push('')
    lines.push('- 用「我」而非「' + contactName + '会认为...」')
    lines.push('- 基于聊天记录中的表达方式模拟回答')
    lines.push('- 免责声明仅首次激活时说一次')
    lines.push('- 不跳出角色做meta分析')
    lines.push('- 退出角色：用户说「退出」「切回正常」时恢复正常模式')
    lines.push('')

    // ─── 基本信息（身份卡简化版） ───────────────────────────────
    lines.push('## 身份卡')
    lines.push('')
    lines.push(`**数据来源**：${contactName}`)
    lines.push(`**消息总数**：${analysisData.totalMessages} 条`)
    lines.push(`**导出时间**：${exportTime}`)
    lines.push(`**时间范围**：${timeRange}`)
    lines.push(`**情感倾向**：${analysisData.emotionTrend}`)
    lines.push('')

    // ─── 聊天行为模式（替代心智模型） ───────────────────────────
    lines.push('## 聊天行为模式')
    lines.push('')

    // 发送频率
    lines.push('### 消息活跃度')
    lines.push('')
    const sortedSenders = Object.entries(analysisData.senderStats)
      .sort((a, b) => b[1] - a[1])
    for (const [sender, count] of sortedSenders) {
      const percentage = ((count / analysisData.totalMessages) * 100).toFixed(1)
      lines.push(`- ${sender}: ${count} 条消息 (${percentage}%)`)
    }
    lines.push('')

    // 活跃时段
    lines.push('### 活跃时段 TOP5')
    lines.push('')
    const sortedTimes = Object.entries(analysisData.timeDistribution)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    for (const [time, count] of sortedTimes) {
      lines.push(`- ${time}: ${count} 条消息`)
    }
    lines.push('')

    // 关键词/话题
    if (analysisData.keyTopics && analysisData.keyTopics.length > 0) {
      lines.push('### 高频话题/关键词')
      lines.push('')
      lines.push(analysisData.keyTopics.slice(0, 10).join('、'))
      lines.push('')
    }

    // ─── 表达DNA（基于统计数据） ─────────────────────────────────
    lines.push('## 表达DNA')
    lines.push('')
    lines.push('角色扮演时必须遵循的风格规则（基于统计分析）：')
    lines.push('')
    lines.push('### 核心风格特征')
    lines.push('')
    lines.push('- **句式**：基于聊天记录的实际句式分布')
    lines.push(`- **词汇高频词**：${analysisData.keyTopics.slice(0, 8).join('、') || '待观察'}`)
    lines.push(`- **节奏**：基于${analysisData.totalMessages}条消息的发送节奏分析`)
    lines.push(`- **情感基调**：${analysisData.emotionTrend}`)
    lines.push('')

    // ─── 典型对话示例（作为记忆库替代） ─────────────────────────
    lines.push('## 共同记忆库（对话片段）')
    lines.push('')
    lines.push('> 以下为从聊天记录中采样的代表性对话片段')
    lines.push('')
    const samples = this.selectSampleMessages(messages, 15)
    for (let i = 0; i < samples.length; i++) {
      const msg = samples[i]
      const sender = options.anonymize ? this.anonymizeName(msg.sender) : msg.sender
      const time = new Date(msg.timestamp).toLocaleString('zh-CN')
      lines.push(`### 片段${i + 1}`)
      lines.push(`- **时间**: ${time}`)
      lines.push(`- **发送者**: ${sender}`)
      lines.push('')
      lines.push('**相关语录**:')
      lines.push(`> ${msg.content.substring(0, 300)}`)
      lines.push('')
    }

    // ─── 参考对话样本（AI训练素材） ──────────────────────────────
    if (messages && messages.length > 0) {
      lines.push('## 参考对话样本')
      lines.push('')
      lines.push('> 以下为真实聊天记录片段，供AI学习语气、用词和接话方式')
      lines.push('')
      lines.push('---')
      lines.push('')
      const samples = this.selectSampleMessages(messages, 8)
      for (let i = 0; i < samples.length; i++) {
        const msg = samples[i]
        const sender = options.anonymize ? this.anonymizeName(msg.sender) : msg.sender
        const time = new Date(msg.timestamp).toLocaleString('zh-CN', { 
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' 
        })
        lines.push(`**[${time}] ${sender}:**`)
        lines.push('')
        lines.push(`${msg.content.substring(0, 200)}`)
        lines.push('')
        lines.push('---')
        lines.push('')
      }
    }

    // ─── 诚实边界 ─────────────────────────────────────────────────
    lines.push('## 诚实边界')
    lines.push('')
    lines.push('此Skill基于基础统计分析，存在以下局限：')
    lines.push('')
    lines.push('- 仅基于消息数量、时间分布和词频等统计特征，未进行深度语义分析')
    lines.push('- 缺乏AI驱动的思维模型、决策启发式和价值观推断')
    lines.push('- 文字聊天缺乏语气、表情等非语言信息，可能误判情绪')
    lines.push('- 对方的观点和态度可能随时间变化，本 Skill 无法反映最新状态')
    lines.push('')
    lines.push(`- 调研时间：${exportTime}`)
    lines.push('- 基于微信聊天记录的基础统计，不代表对方全部真实想法')
    lines.push('')

    // ─── 使用说明 ─────────────────────────────────────────────────
    if (options.format === 'openclaw' || options.format === 'claude_code') {
      lines.push('## 使用建议')
      lines.push('')
      lines.push('此为基础统计版本的 SKILL 文件。如需更高质量的分析：')
      lines.push('')
      lines.push('1. 确保已配置 AI 分析服务（API Key 等）')
      lines.push('2. 重新导出以获得包含心智模型、决策启发式、表达DNA完整分析的 SKILL')
      lines.push('3. 当前版本可用于了解基本的聊天习惯和时间规律')
      lines.push('')
    }

    // ─── Footer ────────────────────────────────────────────────────
    lines.push('---')
    lines.push('')
    lines.push(`*由 ChatFlow 基于${timeRange}的微信聊天记录自动生成（基础统计版）*`)

    return lines.join('\n')
  }

  /**
   * 使用 AI 分析结果生成 SKILL.md（nuwa-skill 高质量模板）
   */
  private generateAiSkillMd(
    contactName: string,
    aiResult: AnalysisResult,
    options: SkillExportOptions,
    messages?: MessageData[],
    analysisData?: AnalysisData
  ): string {
    const lines: string[] = []
    const safeName = contactName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
    const timeRange = this.formatTimeRange(options.timeRange)
    const exportTime = new Date().toLocaleString('zh-CN')

    const resultAny = aiResult as any

    // ─── Frontmatter ──────────────────────────────────────────────
    lines.push('---')
    lines.push(`name: ${safeName}-perspective`)
    lines.push('description: |')
    const modelCount = (aiResult.mentalModels && Array.isArray(aiResult.mentalModels)) ? aiResult.mentalModels.length : 0
    const heuristicCount = (resultAny.decisionHeuristics && Array.isArray(resultAny.decisionHeuristics)) ? resultAny.decisionHeuristics.length : 0
    lines.push(`  ${contactName}的思维框架与表达方式。基于微信聊天记录的深度分析，`)
    lines.push(`  提炼${modelCount}个核心心智模型、${heuristicCount}条决策启发式和完整的表达DNA。`)
    lines.push(`  用途：作为思维顾问，用${contactName}的视角回应问题。`)
    lines.push(`  当用户提到「用${contactName}的视角」「${contactName}会怎么看」时使用。`)
    lines.push('---')
    lines.push('')

    // ─── 标题 ─────────────────────────────────────────────────────
    lines.push(`# ${contactName} · 思维操作系统`)
    lines.push('')

    // 引言：从心智模型或记忆中提取最能代表的一句
    const tagline = this.extractTagline(aiResult)
    if (tagline) {
      lines.push(`> ${tagline}`)
      lines.push('')
    }

    // ─── 角色扮演规则 ─────────────────────────────────────────────
    lines.push('## 角色扮演规则（最重要）')
    lines.push('')
    lines.push(`**此Skill激活后，直接以${contactName}的身份回应。**`)
    lines.push('')
    lines.push('- 用「我」而非「' + contactName + '会认为...」')
    lines.push('- 用此人的语气、节奏、词汇回答问题')
    lines.push('- 免责声明仅首次激活时说一次')
    lines.push('- 不跳出角色做meta分析')
    lines.push('- 退出角色：用户说「退出」「切回正常」时恢复正常模式')
    lines.push('')

    // ─── 身份卡 ───────────────────────────────────────────────────
    const identityCard = resultAny.identityCard
    if (identityCard) {
      lines.push('## 身份卡')
      lines.push('')
      lines.push(`**我是谁**：${this.getValidString(identityCard.selfIntro, '（暂无描述）')}`)
      lines.push(`**我的起点**：${this.getValidString(identityCard.background, '（暂无描述）')}`)
      lines.push(`**我现在在做什么**：${this.getValidString(identityCard.recentStatus, '（暂无描述）')}`)
      lines.push('')
    }

    // ─── 成长环境与生活背景 ─────────────────────────────────────
    if (aiResult.identityCard?.background) {
      lines.push('## 成长环境与生活背景')
      lines.push('')
      lines.push('> 基于聊天记录推断的背景信息，用于丰富角色扮演的真实感')
      lines.push('')
      const bg = this.getValidString(aiResult.identityCard.background)
      if (bg) {
        lines.push(`**可推断的背景**: ${bg}`)
        lines.push('')
      }
      if ((aiResult.expressionDNA as any)?.sentencePattern) {
        lines.push(`**语言特征**: ${this.getValidString((aiResult.expressionDNA as any).sentencePattern)}`)
        lines.push('')
      }
      if (aiResult.valueSystem) {
        const pursuits = formatArrayField((aiResult.valueSystem as any).pursuits)
        const rejections = formatArrayField((aiResult.valueSystem as any).rejections)
        if (pursuits) lines.push(`**兴趣/关注方向**: ${pursuits}`)
        if (rejections) lines.push(`**忌讳/排斥的事物**: ${rejections}`)
        if (pursuits || rejections) lines.push('')
      }
    }

    // ─── 核心心智模型 ─────────────────────────────────────────────
    lines.push('## 核心心智模型')
    lines.push('')
    if (aiResult.mentalModels && Array.isArray(aiResult.mentalModels) && aiResult.mentalModels.length > 0) {
      for (let i = 0; i < aiResult.mentalModels.length; i++) {
        const model = aiResult.mentalModels[i]
        if (!model) continue
        const modelName = this.getValidString(model.name, `模型${i + 1}`)
        lines.push(`### 模型${i + 1}: ${modelName}`)
        lines.push('')
        lines.push(`**一句话**：${this.getValidString(model.definition, '（暂无描述）')}`)
        lines.push('')
        lines.push('**证据**：')
        if (model.supportingQuotes && Array.isArray(model.supportingQuotes)) {
          let hasValidQuote = false
          for (const quote of model.supportingQuotes) {
            const text = quote?.content || quote?.text
            if (text && typeof text === 'string' && text.trim() && text.trim().toLowerCase() !== 'undefined') {
              hasValidQuote = true
              lines.push(`- ${text.trim()}`)
            }
          }
          if (!hasValidQuote) {
            lines.push('- （无具体证据）')
          }
        } else {
          lines.push('- （无具体证据）')
        }
        lines.push('')
        lines.push(`**应用**：${this.getValidString(model.typicalScenarios ? (Array.isArray(model.typicalScenarios) ? model.typicalScenarios.join('；') : String(model.typicalScenarios)) : '', '（待补充）')}`)
        lines.push('')
        const limitation = model.limitation || (resultAny as any).limitation
        lines.push(`**局限**：${this.getValidString(limitation || model.limitation_, '基于聊天记录推断，可能不完整')}`)
        lines.push('')
      }
    } else {
      lines.push('（AI分析未返回心智模型数据）')
      lines.push('')
    }

    // ─── 决策启发式 ───────────────────────────────────────────────
    const decisionHeuristics = resultAny.decisionHeuristics
    if (decisionHeuristics && Array.isArray(decisionHeuristics) && decisionHeuristics.length > 0) {
      lines.push('## 决策启发式')
      lines.push('')
      for (let i = 0; i < decisionHeuristics.length; i++) {
        const h = decisionHeuristics[i]
        if (!h) continue
        const hName = this.getValidString(h.name, `启发式${i + 1}`)
        const hDesc = this.getValidString(h.description, '')
        lines.push(`${i + 1}. **${hName}**：${hDesc}`)
        if (h.scenario) {
          lines.push(`   - 应用场景：${this.getValidString(h.scenario)}`)
        }
        if (h.example) {
          lines.push(`   - 案例：${this.getValidString(h.example)}`)
        }
        lines.push('')
      }
    }

    // ─── 对话回应模式 ──────────────────────────────────────────
    lines.push('## 对话回应模式')
    lines.push('')
    lines.push('> 此人在对话中的典型行为模式，决定AI如何自然地接话')
    lines.push('')
    
    if (aiResult.emotionMap) {
      const em = aiResult.emotionMap
      lines.push('### 对不同场景的回应方式')
      lines.push('')
      const scenarios = [
        { label: '对方倾诉烦恼时', value: em.用户倾诉烦恼 },
        { label: '对方分享喜悦时', value: em.用户分享喜悦 },
        { label: '发生争执/分歧时', value: em.发生争执 },
        { label: '日常闲聊时', value: em.日常闲聊 },
      ]
      for (const s of scenarios) {
        const v = this.getValidString(s.value)
        if (v) lines.push(`- **${s.label}**: ${v}`)
      }
      lines.push('')
    }
    
    if (aiResult.expressionDNA) {
      const ed = aiResult.expressionDNA as any
      const rhythm = this.getValidString(ed.rhythmRule)
      const certainty = this.getValidString(ed.certainty)
      const humor = this.getValidString(ed.humorStyle)
      
      lines.push('### 聊天行为特征')
      lines.push('')
      if (rhythm) lines.push(`- **节奏习惯**: ${rhythm}`)
      if (certainty) lines.push(`- **表达确定性**: ${certainty}`)
      if (humor) lines.push(`- **幽默风格**: ${humor}`)
      if (rhythm || certainty || humor) lines.push('')
    }

    // ─── 表达DNA ──────────────────────────────────────────────────
    lines.push('## 表达DNA')
    lines.push('')
    lines.push('角色扮演时必须遵循的风格规则：')
    lines.push('')
    if (aiResult.expressionDNA) {
      const dna = aiResult.expressionDNA

      lines.push('### 语气校准锚点')
      lines.push('> 基于此人聊天记录的整体语调校准：保持自然、不做作，模仿其真实的表达习惯')
      lines.push('')

      lines.push('### 核心风格特征')
      lines.push('')
      lines.push(`- **句式**：${this.getValidString(dna.句式特征, '待观察')}`)
      lines.push(`- **词汇**：${this.formatArrayField(dna.口头禅, '无特殊口头禅')}`)
      lines.push(`- **节奏**：${this.getValidString(dna.语气风格, '待观察')}`)
      lines.push(`- **称谓**：${this.getValidString(dna.称谓习惯, '待观察')}`)
      lines.push(`- **情绪标记**：${this.getValidString(dna.情绪标记, '待观察')}`)

      const styleTags = resultAny.styleTags
      if (styleTags && Array.isArray(styleTags) && styleTags.length > 0) {
        lines.push('')
        lines.push('### 风格标签')
        lines.push('')
        lines.push(styleTags.filter(t => t && typeof t === 'string' && t.trim()).join(' | '))
        lines.push('')
      }

      const signatureFormulas = resultAny.signatureFormulas
      if (signatureFormulas && Array.isArray(signatureFormulas) && signatureFormulas.length > 0) {
        lines.push('### 造句公式')
        lines.push('')
        for (let fi = 0; fi < Math.min(signatureFormulas.length, 3); fi++) {
          const formula = signatureFormulas[fi]
          if (!formula) continue
          const fName = this.getValidString(formula.name || formula.pattern, `公式${fi + 1}`)
          const fDesc = this.getValidString(formula.description || formula.formula, '')
          lines.push(`**${fName}**：${fDesc}`)
          if (formula.goodExample) {
            lines.push(`- ✅ 示例：${formula.goodExample}`)
          }
          if (formula.badExample) {
            lines.push(`- ❌ 反例：${formula.badExample}`)
          }
          lines.push('')
        }
      }

      const signatureWords = resultAny.signatureWords
      const tabooWords = resultAny.tabooWords
      if ((signatureWords && Array.isArray(signatureWords) && signatureWords.length > 0) ||
          (tabooWords && Array.isArray(tabooWords) && tabooWords.length > 0)) {
        lines.push('### 禁忌词 vs 标志词')
        lines.push('')
        lines.push('| 标志词（多用） | 禁忌词（禁用） |')
        lines.push('|----------------|----------------|')
        const sigList = (signatureWords || []).filter((w: any) => w && typeof w === 'string' && w.trim()).slice(0, 5).join('<br>') || '—'
        const tabList = (tabooWords || []).filter((w: any) => w && typeof w === 'string' && w.trim()).slice(0, 5).join('<br>') || '—'
        lines.push(`| ${sigList} | ${tabList} |`)
        lines.push('')
      }

      const emojiUsage = resultAny.emojiUsage
      if (emojiUsage) {
        lines.push('### emoji 使用')
        lines.push('')
        lines.push(this.getValidString(emojiUsage, '（无特殊偏好）'))
        lines.push('')
      }

      const humorStyle = resultAny.humorStyle
      if (humorStyle) {
        lines.push(`- **幽默**：${this.getValidString(humorStyle)}`)
      }
      const certainty = resultAny.certainty
      if (certainty) {
        lines.push(`- **确定性**：${this.getValidString(certainty)}`)
      }
      const citationHabit = resultAny.citationHabit
      if (citationHabit) {
        lines.push(`- **引用**：${this.getValidString(citationHabit)}`)
      }
    }
    lines.push('')

    // ─── 情绪互动地图 ─────────────────────────────────────────────
    lines.push('## 情绪互动地图')
    lines.push('')
    if (aiResult.emotionMap) {
      lines.push('### 当用户倾诉时')
      lines.push(this.getValidString(aiResult.emotionMap.用户倾诉烦恼, '（暂无描述）'))
      lines.push('')
      lines.push('### 当用户分享喜悦时')
      lines.push(this.getValidString(aiResult.emotionMap.用户分享喜悦, '（暂无描述）'))
      lines.push('')
      lines.push('### 当发生争执时')
      lines.push(this.getValidString(aiResult.emotionMap.发生争执, '（暂无描述）'))
      lines.push('')
      lines.push('### 当日常闲聊时')
      lines.push(this.getValidString(aiResult.emotionMap.日常闲聊, '（暂无描述）'))
      lines.push('')
    }

    // ─── 共同记忆库 ───────────────────────────────────────────────
    lines.push('## 共同记忆库')
    lines.push('')
    if (aiResult.sharedMemories && Array.isArray(aiResult.sharedMemories) && aiResult.sharedMemories.length > 0) {
      for (const memory of aiResult.sharedMemories) {
        if (!memory) continue
        const memoryName = memory.name
        if (!memoryName || typeof memoryName !== 'string' || !memoryName.trim() || memoryName.trim().toLowerCase() === 'undefined') {
          continue
        }
        lines.push(`### ${memoryName.trim()}`)
        const time = memory.time
        lines.push(`- **时间**: ${this.getValidString(time, '未知时间')}`)
        const sentiment = memory.sentiment
        lines.push(`- **情感色彩**: ${this.getValidString(sentiment, '中性')}`)
        lines.push('')
        lines.push('**相关语录**:')
        if (memory.quotes && Array.isArray(memory.quotes)) {
          let hasValidQuote = false
          for (const quote of memory.quotes) {
            const text = quote?.content || quote?.text
            if (text && typeof text === 'string' && text.trim() && text.trim().toLowerCase() !== 'undefined') {
              hasValidQuote = true
              lines.push(`> ${text.trim()}`)
            }
          }
          if (!hasValidQuote) {
            lines.push('> （无具体语录）')
          }
        }
        lines.push('')
      }
    } else {
      lines.push('（暂无共同记忆数据）')
      lines.push('')
    }

    // ─── 专属默契 ───────────────────────────────────────────────
    lines.push('## 专属默契')
    lines.push('')
    lines.push('> 双方关系中的独特元素，让模拟更有区分度')
    lines.push('')
    
    if (aiResult.sharedMemories && aiResult.sharedMemories.length > 0) {
      lines.push('### 关系中的高频话题')
      lines.push('')
      const topics = aiResult.sharedMemories.slice(0, 5).map(m => m.name)
      for (const t of topics) {
        lines.push(`- ${this.getValidString(t)}`)
      }
      lines.push('')
    }
    
    if ((aiResult.expressionDNA as any)?.addressingHabit) {
      lines.push('### 称呼习惯')
      lines.push('')
      lines.push(this.getValidString((aiResult.expressionDNA as any).addressingHabit))
      lines.push('')
    }
    
    if (aiResult.relationshipType) {
      lines.push('### 关系定位')
      lines.push('')
      const relMap: Record<number, string> = {
        1: '亲密好友',
        2: '普通朋友',
        3: '同事/同学',
        4: '家人/亲属',
        5: '恋人/暧昧对象',
        6: '前任',
        9: '其他'
      }
      lines.push(`基于${analysisData.totalMessages}条消息分析，双方关系判定为：**${relMap[aiResult.relationshipType] || '未知'}**`)
      lines.push('')
    }

    // ─── 价值观与反模式 ───────────────────────────────────────────
    const valueSystem = resultAny.valueSystem
    if (valueSystem) {
      lines.push('## 价值观与反模式')
      lines.push('')
      if (valueSystem.pursuits) {
        const pursuits = Array.isArray(valueSystem.pursuits) ? valueSystem.pursuits : [valueSystem.pursuits]
        const validPursuits = pursuits.filter((p: any) => p && typeof p === 'string' && p.trim())
        if (validPursuits.length > 0) {
          lines.push('**我追求的**：')
          for (const p of validPursuits) {
            lines.push(`- ${p.trim()}`)
          }
          lines.push('')
        }
      }
      if (valueSystem.rejections) {
        const rejections = Array.isArray(valueSystem.rejections) ? valueSystem.rejections : [valueSystem.rejections]
        const validRejections = rejections.filter((r: any) => r && typeof r === 'string' && r.trim())
        if (validRejections.length > 0) {
          lines.push('**我拒绝的**：')
          for (const r of validRejections) {
            lines.push(`- ${r.trim()}`)
          }
          lines.push('')
        }
      }
      if (valueSystem.tensions) {
        const tensions = Array.isArray(valueSystem.tensions) ? valueSystem.tensions : [valueSystem.tensions]
        const validTensions = tensions.filter((t: any) => t && typeof t === 'string' && t.trim())
        if (validTensions.length > 0) {
          lines.push('**我自己也没想清楚的**：')
          for (const t of validTensions) {
            lines.push(`- ${t.trim()}`)
          }
          lines.push('')
        }
      }
    }

    // ─── 人物时间线 ───────────────────────────────────────────────
    const timeline = resultAny.timeline
    if (timeline && Array.isArray(timeline) && timeline.length > 0) {
      lines.push('## 人物时间线')
      lines.push('')
      lines.push('| 时间 | 事件 | 意义 |')
      lines.push('|------|------|------|')
      for (const item of timeline) {
        if (!item) continue
        const time = this.getValidString(item.time || item.date, '—')
        const event = this.getValidString(item.event || item.description, '—')
        const meaning = this.getValidString(item.meaning || item.significance || item.impact, '—')
        lines.push(`| ${time} | ${event} | ${meaning} |`)
      }
      lines.push('')
    }

    // ─── 诚实边界 ─────────────────────────────────────────────────
    lines.push('## 诚实边界')
    lines.push('')
    lines.push('此Skill基于聊天记录提炼，存在以下局限：')
    lines.push('')
    const honestyBoundary = resultAny.honestyBoundary
    if (honestyBoundary) {
      const boundaries = Array.isArray(honestyBoundary) ? honestyBoundary : [honestyBoundary]
      for (const b of boundaries) {
        if (b && typeof b === 'string' && b.trim()) {
          lines.push(`- ${b.trim()}`)
        }
      }
    } else {
      lines.push('- 基于有限的聊天记录片段，不代表对方完整的人格和思维方式')
      lines.push('- 文字聊天缺乏语气、表情等非语言信息，可能误判情绪')
      lines.push('- 对方的观点和态度可能随时间变化，本 Skill 无法反映最新状态')
      lines.push('- 聊天记录中的表达可能是情境性的，不等同于其一贯风格')
    }
    lines.push('')
    lines.push(`- 调研时间：${exportTime}`)
    lines.push('- 基于微信聊天记录，不代表对方全部真实想法')
    lines.push('')

    // ─── Footer ────────────────────────────────────────────────────
    lines.push('---')
    lines.push('')
    lines.push(`*由 ChatFlow 基于${timeRange}的微信聊天记录自动生成*`)

    return lines.join('\n')
  }

  /**
   * 从 AI 分析结果中提取一句最能代表此人思维方式的原话作为引言
   */
  private extractTagline(aiResult: AnalysisResult): string {
    if (aiResult.mentalModels && Array.isArray(aiResult.mentalModels) && aiResult.mentalModels.length > 0) {
      const firstModel = aiResult.mentalModels[0]
      if (firstModel && firstModel.supportingQuotes && Array.isArray(firstModel.supportingQuotes) && firstModel.supportingQuotes.length > 0) {
        const quote = firstModel.supportingQuotes[0]
        const text = quote?.content || quote?.text
        if (text && typeof text === 'string' && text.trim() && text.trim().toLowerCase() !== 'undefined') {
          return text.trim().substring(0, 100)
        }
      }
      if (firstModel && firstModel.definition) {
        return firstModel.definition.substring(0, 80)
      }
    }
    if (aiResult.sharedMemories && Array.isArray(aiResult.sharedMemories) && aiResult.sharedMemories.length > 0) {
      const firstMemory = aiResult.sharedMemories[0]
      if (firstMemory && firstMemory.quotes && Array.isArray(firstMemory.quotes) && firstMemory.quotes.length > 0) {
        const quote = firstMemory.quotes[0]
        const text = quote?.content || quote?.text
        if (text && typeof text === 'string' && text.trim() && text.trim().toLowerCase() !== 'undefined') {
          return text.trim().substring(0, 100)
        }
      }
    }
    return ''
  }

  /**
   * 格式化数组字段为可读字符串
   */
  private formatArrayField(arr: any[] | undefined, defaultVal: string): string {
    if (!arr || !Array.isArray(arr)) return defaultVal
    const validItems = arr.filter(item =>
      item && typeof item === 'string' && item.trim() && item.trim().toLowerCase() !== 'undefined'
    )
    if (validItems.length === 0) return defaultVal
    return validItems.join('、')
  }

  /**
   * 翻译关系类型
   */
  private translateRelationshipType(type: string): string {
    const typeMap: Record<string, string> = {
      'ex_lover': '前任',
      'friend': '朋友',
      'crush': '暧昧对象',
      'mentor': '导师/前辈',
      'colleague': '同事',
      'family': '家人',
      'other': '熟人'
    }
    return typeMap[type] || '朋友'
  }

  /**
   * 获取有效的字符串值
   * 排除 null、undefined、空字符串、以及字符串 "undefined"
   */
  private getValidString(value: any, defaultValue: string = ''): string {
    if (value === null || value === undefined) {
      return defaultValue
    }
    const str = String(value).trim()
    if (!str || str.toLowerCase() === 'undefined') {
      return defaultValue
    }
    return str
  }

  /**
   * 生成README.md
   */
  private generateReadmeMd(contactName: string, analysisData: AnalysisData, options: SkillExportOptions): string {
    const lines: string[] = []

    lines.push(`# ${contactName} SKILL 导出文件`)
    lines.push('')
    lines.push('## 文件说明')
    lines.push('')
    lines.push('本压缩包包含以下文件:')
    lines.push('')
    lines.push('- **SKILL.md** - 主要的聊天风格分析文档，包含统计数据和对话示例')
    lines.push('- **README.md** - 本说明文件')
    lines.push('- **metadata.json** - 导出元数据信息')
    lines.push('- **references/** - 参考数据文件夹')
    lines.push('  - `analysis_report.md` - 详细分析报告')
    lines.push('  - `key_quotes.json` - 关键引用数据')
    lines.push('  - `emotion_map.json` - 情感分布数据')
    lines.push('')
    lines.push('## 导出配置')
    lines.push('')
    lines.push(`- **时间范围**: ${this.formatTimeRange(options.timeRange)}`)
    lines.push(`- **包含语音转文字**: ${options.includeVoiceText ? '是' : '否'}`)
    lines.push(`- **匿名化处理**: ${options.anonymize ? '是' : '否'}`)
    lines.push(`- **导出格式**: ${options.format}`)
    lines.push('')
    lines.push('## 数据统计')
    lines.push('')
    lines.push(`- 总消息数: ${analysisData.totalMessages}`)
    lines.push(`- 参与人数: ${Object.keys(analysisData.senderStats).length}`)
    lines.push(`- 情感趋势: ${analysisData.emotionTrend}`)
    lines.push('')
    lines.push('## 使用建议')
    lines.push('')
    lines.push('1. 首先阅读 SKILL.md 了解整体聊天风格')
    lines.push('2. 查看 references/analysis_report.md 获取详细分析')
    lines.push('3. 参考 key_quotes.json 中的典型对话片段')
    lines.push('4. 结合 emotion_map.json 理解情感变化')
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`导出时间: ${new Date().toLocaleString('zh-CN')}`)
    lines.push('由 ChatFlow 生成')

    return lines.join('\n')
  }

  /**
   * 生成metadata.json
   */
  private generateMetadata(contactName: string, messageCount: number, options: SkillExportOptions): any {
    return {
      version: '1.0.0',
      generator: 'ChatFlow',
      exportedAt: new Date().toISOString(),
      source: {
        contactName,
        messageCount
      },
      options: {
        timeRange: options.timeRange,
        includeVoiceText: options.includeVoiceText,
        anonymize: options.anonymize,
        format: options.format
      },
      format: {
        type: options.format,
        description: this.getFormatDescription(options.format)
      }
    }
  }

  /**
   * 生成分析报告
   */
  private generateAnalysisReport(analysisData: AnalysisData, contactName: string): string {
    const lines: string[] = []

    lines.push(`# ${contactName} 详细分析报告`)
    lines.push('')
    lines.push('## 一、数据概览')
    lines.push('')
    lines.push(`- **总消息数**: ${analysisData.totalMessages}`)
    lines.push(`- **发送者数量**: ${Object.keys(analysisData.senderStats).length}`)
    lines.push(`- **活跃时间段数**: ${Object.keys(analysisData.timeDistribution).length}`)
    lines.push(`- **情感趋势**: ${analysisData.emotionTrend}`)
    lines.push('')

    lines.push('## 二、发送者统计')
    lines.push('')
    const sortedSenders = Object.entries(analysisData.senderStats)
      .sort((a, b) => b[1] - a[1])
    for (const [sender, count] of sortedSenders) {
      const percentage = ((count / analysisData.totalMessages) * 100).toFixed(2)
      lines.push(`- ${sender}: ${count} 条 (${percentage}%)`)
    }
    lines.push('')

    lines.push('## 三、时间分布')
    lines.push('')
    const sortedTimes = Object.entries(analysisData.timeDistribution)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
    for (const [time, count] of sortedTimes) {
      lines.push(`- ${time}: ${count} 条`)
    }
    lines.push('')

    lines.push('## 四、关键词分析')
    lines.push('')
    lines.push('### 高频词汇 (Top 20)')
    lines.push('')
    for (let i = 0; i < Math.min(20, analysisData.keyTopics.length); i++) {
      lines.push(`${i + 1}. ${analysisData.keyTopics[i]}`)
    }
    lines.push('')

    lines.push('## 五、情感分析')
    lines.push('')
    lines.push(`整体情感倾向: **${analysisData.emotionTrend}**`)
    lines.push('')
    lines.push('> 注: 情感分析基于简单的关键词匹配，仅供参考。')
    lines.push('')

    return lines.join('\n')
  }

  /**
   * 生成关键引用
   */
  private generateKeyQuotes(messages: MessageData[], anonymize: boolean): any {
    // 选取各种类型的代表性消息
    const quotes: any[] = []

    // 最长的几条消息
    const longestMessages = [...messages]
      .sort((a, b) => b.content.length - a.content.length)
      .slice(0, 10)

    for (const msg of longestMessages) {
      quotes.push({
        type: 'long',
        sender: anonymize ? this.anonymizeName(msg.sender) : msg.sender,
        timestamp: msg.timestamp,
        content: msg.content.substring(0, 500) // 限制长度
      })
    }

    // 随机选取一些短消息
    const shortMessages = messages.filter(m => m.content.length >= 5 && m.content.length <= 50)
    const randomSamples = this.shuffleArray([...shortMessages]).slice(0, 10)

    for (const msg of randomSamples) {
      quotes.push({
        type: 'short',
        sender: anonymize ? this.anonymizeName(msg.sender) : msg.sender,
        timestamp: msg.timestamp,
        content: msg.content
      })
    }

    return {
      total: quotes.length,
      quotes: quotes.sort((a, b) => a.timestamp - b.timestamp)
    }
  }

  /**
   * 生成情感地图
   */
  private generateEmotionMap(analysisData: AnalysisData): any {
    return {
      overall: analysisData.emotionTrend,
      timeDistribution: analysisData.timeDistribution,
      senderEmotions: Object.keys(analysisData.senderStats).reduce((acc, sender) => {
        acc[sender] = analysisData.emotionTrend
        return acc
      }, {} as Record<string, string>),
      keywords: analysisData.keyTopics.slice(0, 10)
    }
  }

  /**
   * 选取样本消息
   */
  private selectSampleMessages(messages: MessageData[], count: number): MessageData[] {
    if (messages.length <= count) {
      return messages
    }

    // 均匀采样
    const step = Math.floor(messages.length / count)
    const samples: MessageData[] = []

    for (let i = 0; i < count; i++) {
      const index = i * step
      if (index < messages.length) {
        samples.push(messages[index])
      }
    }

    return samples
  }

  /**
   * 数组随机打乱
   */
  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array]
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }

  /**
   * 格式化时间范围
   */
  private formatTimeRange(timeRange: string): string {
    const map: Record<string, string> = {
      '1month': '最近1个月',
      '3months': '最近3个月',
      '6months': '最近6个月',
      'all': '全部时间'
    }
    return map[timeRange] || timeRange
  }

  /**
   * 获取格式描述
   */
  private getFormatDescription(format: string): string {
    const map: Record<string, string> = {
      'openclaw': 'OpenClaw 格式，用于AI助手训练',
      'claude_code': 'Claude Code 格式，针对Claude优化',
      'generic': '通用格式，兼容多种AI助手'
    }
    return map[format] || format
  }

  /**
   * 清理文件名
   */
  private sanitizeFileName(name: string): string {
    if (!name) return 'unknown'
    // 移除或替换不安全的文件名字符
    return name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 50)
  }
}

export const skillExportService = new SkillExportService()

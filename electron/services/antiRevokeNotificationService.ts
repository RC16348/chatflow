import { Notification } from 'electron'
import { ConfigService } from './config'
import { chatService } from './chatService'
import type { Message } from '../../src/types/models'
import * as fs from 'fs'
import * as path from 'path'

const ANTI_REVOKE_CONFIG_KEYS = new Set([
  'antiRevokeNotificationEnabled',
  'antiRevokeNotificationShowContent',
  'dbPath',
  'decryptKey',
  'myWxid'
])

// 系统消息类型
const SYSTEM_MESSAGE_TYPE = 10000

// 撤回消息内容匹配模式
const REVOKE_MESSAGE_PATTERNS = [
  /撤回了一条消息/,
  /尝试撤回此消息/,
  /recall.*message/i,
  /revoke.*message/i
]

// 1分钟的时间窗口（毫秒）
const ONE_MINUTE_MS = 60 * 1000

class AntiRevokeNotificationService {
  private readonly configService: ConfigService
  private started = false
  // 已通知的撤回消息ID集合（内存缓存）
  private notifiedRevokedMessages = new Set<string>()
  // 持久化文件路径
  private persistFilePath: string | null = null
  private readonly maxCacheSize = 1000

  constructor() {
    this.configService = ConfigService.getInstance()
    this.initPersistFile()
  }

  // 初始化持久化文件路径
  private initPersistFile(): void {
    try {
      const userDataPath = this.configService.getCacheBasePath()
      if (userDataPath) {
        this.persistFilePath = path.join(userDataPath, 'anti_revoke_notified.json')
        this.loadNotifiedMessages()
      }
    } catch (e) {
      console.error('[AntiRevokeNotification] 初始化持久化文件失败:', e)
    }
  }

  // 从文件加载已通知的消息ID
  private loadNotifiedMessages(): void {
    if (!this.persistFilePath) return
    try {
      if (fs.existsSync(this.persistFilePath)) {
        const data = fs.readFileSync(this.persistFilePath, 'utf-8')
        const messages = JSON.parse(data) as string[]
        messages.forEach(id => this.notifiedRevokedMessages.add(id))
        console.log(`[AntiRevokeNotification] 已加载 ${messages.length} 条已通知记录`)
      }
    } catch (e) {
      console.error('[AntiRevokeNotification] 加载已通知记录失败:', e)
    }
  }

  // 保存已通知的消息ID到文件
  private saveNotifiedMessages(): void {
    if (!this.persistFilePath) return
    try {
      const messages = Array.from(this.notifiedRevokedMessages)
      fs.writeFileSync(this.persistFilePath, JSON.stringify(messages), 'utf-8')
    } catch (e) {
      console.error('[AntiRevokeNotification] 保存已通知记录失败:', e)
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    console.log('[AntiRevokeNotificationService] Started')
  }

  /**
   * 检查消息时间是否在1分钟内
   */
  private isWithinOneMinute(messageTime: number): boolean {
    const now = Date.now()
    // messageTime 可能是秒或毫秒，需要判断
    const timeMs = messageTime > 1000000000000 ? messageTime : messageTime * 1000
    return (now - timeMs) <= ONE_MINUTE_MS
  }

  /**
   * 检查消息列表中是否包含撤回消息，如果是则发送通知
   * 此方法由 chatService 在加载消息时调用
   */
  checkMessagesForRevoke(sessionId: string, messages: Message[]): void {
    if (!this.isNotificationEnabled()) return
    if (!messages || messages.length === 0) return

    for (const message of messages) {
      // 检查是否为系统消息（localType = 10000）
      if (message.localType !== SYSTEM_MESSAGE_TYPE) continue

      // 检查消息内容是否包含撤回相关文本
      const content = message.parsedContent || message.content || ''
      if (!this.isRevokeMessageContent(content)) continue

      // 过滤自己撤回的消息
      if (this.isSelfRevoke(content)) {
        console.log(`[AntiRevokeNotification] 跳过自己撤回的消息: ${sessionId}`)
        continue
      }

      // 检查消息时间是否在1分钟内
      const msgTime = message.createTime || message.sortSeq || 0
      if (!this.isWithinOneMinute(msgTime)) {
        console.log(`[AntiRevokeNotification] 跳过过期撤回消息: ${sessionId}, time=${msgTime}`)
        continue
      }

      // 使用 sessionId + localId + serverId 作为唯一标识
      const uniqueKey = `${sessionId}:${message.localId}:${message.serverId}`

      // 检查是否已经通知过
      if (this.hasNotified(uniqueKey)) {
        continue
      }
      this.markAsNotified(uniqueKey)

      // 提取发送者信息
      const senderName = this.extractSenderNameFromRevokeContent(content) || message.senderDisplayName || '某人'

      // 发送通知
      this.sendRevokeNotification(sessionId, uniqueKey, senderName).catch(err => {
        console.error('[AntiRevokeNotification] 发送撤回通知失败:', err)
      })
    }
  }

  /**
   * 从会话摘要检查是否有撤回消息（用于会话列表监控）
   */
  checkSessionForRevoke(sessionId: string, summary: string, timestamp: number, displayName: string): void {
    if (!this.isNotificationEnabled()) return
    if (!summary) return

    // 检查是否是撤回消息
    if (!this.isRevokeMessageContent(summary)) return

    // 过滤自己撤回的消息
    if (this.isSelfRevoke(summary)) {
      console.log(`[AntiRevokeNotification] 跳过自己撤回的消息: ${sessionId}`)
      return
    }

    // 检查时间是否在1分钟内
    if (!this.isWithinOneMinute(timestamp)) {
      console.log(`[AntiRevokeNotification] 跳过过期会话撤回: ${sessionId}, time=${timestamp}`)
      return
    }

    // 使用会话ID+时间戳作为唯一标识（会话列表没有localId/serverId）
    const uniqueKey = `session:${sessionId}:${timestamp}`

    // 检查是否已经通知过
    if (this.hasNotified(uniqueKey)) {
      return
    }
    this.markAsNotified(uniqueKey)

    // 提取发送者名称
    const senderName = this.extractSenderNameFromRevokeContent(summary) || '某人'

    // 发送通知
    this.sendRevokeNotification(sessionId, uniqueKey, senderName, displayName).catch(err => {
      console.error('[AntiRevokeNotification] 发送撤回通知失败:', err)
    })
  }

  /**
   * 检查是否已经通知过
   */
  private hasNotified(key: string): boolean {
    return this.notifiedRevokedMessages.has(key)
  }

  /**
   * 标记为已通知
   */
  private markAsNotified(key: string): void {
    // 如果缓存已满，清空一半
    if (this.notifiedRevokedMessages.size >= this.maxCacheSize) {
      const keysToDelete = Array.from(this.notifiedRevokedMessages).slice(0, this.maxCacheSize / 2)
      for (const key of keysToDelete) {
        this.notifiedRevokedMessages.delete(key)
      }
    }
    this.notifiedRevokedMessages.add(key)
    // 持久化到文件
    this.saveNotifiedMessages()
  }

  /**
   * 判断消息内容是否为撤回消息
   */
  private isRevokeMessageContent(content: string): boolean {
    if (!content) return false
    return REVOKE_MESSAGE_PATTERNS.some(pattern => pattern.test(content))
  }

  /**
   * 判断是否是自己撤回的消息
   * 自己撤回的消息内容通常包含"你"或"You"
   */
  private isSelfRevoke(content: string): boolean {
    if (!content) return false
    // 匹配 "你撤回了一条消息" 或 "You recalled a message"
    return /^你\s*撤回/.test(content) || /^You\s+recalled/i.test(content)
  }

  /**
   * 从撤回消息内容中提取发送者名称
   */
  private extractSenderNameFromRevokeContent(content: string): string | null {
    if (!content) return null
    const match = content.match(/^(.+?)(?:\s*撤回了一条消息|\s*尝试撤回此消息)/)
    if (match) {
      return match[1].trim()
    }
    return null
  }

  /**
   * 发送撤回通知
   * 通知内容固定为：对方尝试撤回一条消息
   */
  private async sendRevokeNotification(
    sessionId: string,
    messageId: string,
    senderName: string,
    displayName?: string
  ): Promise<void> {
    // 获取会话信息
    let finalDisplayName = displayName
    if (!finalDisplayName) {
      const sessionResult = await chatService.getContactAvatar(sessionId)
      finalDisplayName = sessionResult?.displayName || sessionId
    }

    // 固定通知内容
    const notificationContent = '对方尝试撤回一条消息'

    // 发送通知
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: `${finalDisplayName} - ${senderName} 撤回了一条消息`,
        body: notificationContent,
        silent: false
      })
      notif.show()
      console.log(`[AntiRevokeNotificationService] Notified: ${finalDisplayName} - ${senderName}`)
    } else {
      console.warn('[AntiRevokeNotificationService] 当前系统不支持原生通知')
    }
  }

  async handleConfigChanged(key: string): Promise<void> {
    if (!ANTI_REVOKE_CONFIG_KEYS.has(String(key || '').trim())) return

    if (key === 'antiRevokeNotificationEnabled') {
      const enabled = this.isNotificationEnabled()
      console.log(`[AntiRevokeNotificationService] Notification ${enabled ? 'enabled' : 'disabled'}`)
    }
  }

  private isNotificationEnabled(): boolean {
    return this.configService.get('antiRevokeNotificationEnabled') === true
  }
}

export const antiRevokeNotificationService = new AntiRevokeNotificationService()

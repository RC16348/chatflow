import { WcdbCore } from './wcdbCore'

/**
 * WCDB 服务 (主线程直接加载)
 * 与 CipherTalk 保持一致，避免 Worker 线程导致的 DLL 验证问题
 */
export class WcdbService {
  private core: WcdbCore
  private monitorListeners = new Set<(type: string, json: string) => void>()
  private monitorSetup = false

  constructor() {
    this.core = new WcdbCore()
  }

  /**
   * 设置资源路径
   */
  setPaths(resourcesPath: string, userDataPath: string): void {
    this.core.setPaths(resourcesPath, userDataPath)
  }

  /**
   * 启用/禁用日志
   */
  setLogEnabled(enabled: boolean): void {
    this.core.setLogEnabled(enabled)
  }

  /**
   * 设置数据库监控回调（支持多个监听器）
   */
  setMonitor(callback: (type: string, json: string) => void): void {
    this.monitorListeners.add(callback)

    // 首次设置时，启动原生 DLL 的监控管道
    if (!this.monitorSetup) {
      const started = this.core.setMonitor((type, json) => {
        for (const listener of this.monitorListeners) {
          try {
            listener(type, json)
          } catch (error) {
            console.error('[WcdbService] 监控回调失败:', error)
          }
        }
      })

      if (started) {
        this.monitorSetup = true
        console.log('[WcdbService] DB 变更监控管道启动成功')
      } else {
        // 启动失败，不标记为已设置，允许下次 setMonitor 时重试
        this.monitorSetup = false
        console.warn('[WcdbService] DB 变更监控管道启动失败，将在下次连接时重试')
      }
    }
  }

  /**
   * 重新启动监控管道（DLL wcdb_shutdown 后文件监控会停止，需要重新启动）
   */
  private restartMonitor(): void {
    if (this.monitorListeners.size === 0) return

    // 先停止旧的管道连接（如果有）
    try {
      this.core.stopMonitor()
    } catch { }

    // 重置标志并重新启动
    this.monitorSetup = false
    const started = this.core.setMonitor((type, json) => {
      for (const listener of this.monitorListeners) {
        try {
          listener(type, json)
        } catch (error) {
          console.error('[WcdbService] 监控回调失败:', error)
        }
      }
    })

    if (started) {
      this.monitorSetup = true
      console.log('[WcdbService] DB 变更监控管道重新启动成功')
    } else {
      this.monitorSetup = false
      console.warn('[WcdbService] DB 变更监控管道重新启动失败')
    }
  }

  /**
   * 检查服务是否就绪
   */
  isReady(): boolean {
    return true // 主线程直接加载，始终就绪
  }

  // ==========================================
  // 代理方法 (Proxy Methods)
  // ==========================================

  /**
   * 测试数据库连接
   */
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    return this.core.testConnection(dbPath, hexKey, wxid)
  }

  /**
   * 打开数据库（每次 open 成功后重新启动监控管道）
   */
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    const ok = await this.core.open(dbPath, hexKey, wxid)
    if (ok && this.monitorListeners.size > 0) {
      // open 成功且有监听器时，标记需要重启，让后续 setupDbMonitor 或 setImmediate 来执行
      // 因为 wcdb_init（DLL 内部在 open 时调用）不会自动重启文件监控
      this.monitorSetup = false
      // 使用 setImmediate 延迟重启，避免同步 DLL 调用阻塞 open 返回
      // 如果 chatService.connect() 紧接着调 setupDbMonitor()，会由那边负责重启
      setImmediate(() => {
        if (!this.monitorSetup && this.monitorListeners.size > 0) {
          this.restartMonitor()
        }
      })
    }
    return ok
  }

  async getLastInitError(): Promise<string | null> {
    return this.core.getLastInitError()
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    this.core.close()
  }

  /**
   * 关闭服务
   */
  async shutdown(): Promise<void> {
    try { await this.close() } catch {}
  }

  /**
   * 获取数据库连接状态
   */
  async isConnected(): Promise<boolean> {
    return this.core.isConnected()
  }

  /**
   * 获取会话列表
   */
  async getSessions(): Promise<{ success: boolean; sessions?: any[]; error?: string }> {
    return this.core.getSessions()
  }

  /**
   * 获取消息列表
   */
  async getMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    return this.core.getMessages(sessionId, limit, offset)
  }

  /**
   * 获取新消息（增量刷新）
   */
  async getNewMessages(sessionId: string, minTime: number, limit: number = 1000): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    return this.core.getNewMessages(sessionId, minTime, limit)
  }

  /**
   * 获取消息总数
   */
  async getMessageCount(sessionId: string): Promise<{ success: boolean; count?: number; error?: string }> {
    return this.core.getMessageCount(sessionId)
  }

  async getMessageCounts(sessionIds: string[]): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    return this.core.getMessageCounts(sessionIds)
  }

  async getSessionMessageCounts(sessionIds: string[]): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    return this.core.getSessionMessageCounts(sessionIds)
  }

  async getSessionMessageTypeStats(
    sessionId: string,
    beginTimestamp: number = 0,
    endTimestamp: number = 0
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getSessionMessageTypeStats(sessionId, beginTimestamp, endTimestamp)
  }

  async getSessionMessageTypeStatsBatch(
    sessionIds: string[],
    options?: {
      beginTimestamp?: number
      endTimestamp?: number
      quickMode?: boolean
      includeGroupSenderCount?: boolean
    }
  ): Promise<{ success: boolean; data?: Record<string, any>; error?: string }> {
    return this.core.getSessionMessageTypeStatsBatch(sessionIds, options)
  }

  async getSessionMessageDateCounts(sessionId: string): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    return this.core.getSessionMessageDateCounts(sessionId)
  }

  async getSessionMessageDateCountsBatch(sessionIds: string[]): Promise<{ success: boolean; data?: Record<string, Record<string, number>>; error?: string }> {
    return this.core.getSessionMessageDateCountsBatch(sessionIds)
  }

  async getMessagesByType(
    sessionId: string,
    localType: number,
    ascending = false,
    limit = 0,
    offset = 0
  ): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.core.getMessagesByType(sessionId, localType, ascending, limit, offset)
  }

  async getMediaStream(options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }): Promise<{
    success: boolean
    items?: Array<{
      sessionId: string
      sessionDisplayName?: string
      mediaType: 'image' | 'video'
      localId: number
      serverId?: string
      createTime: number
      localType: number
      senderUsername?: string
      isSend?: number | null
      imageMd5?: string
      imageDatName?: string
      videoMd5?: string
      content?: string
    }>
    hasMore?: boolean
    nextOffset?: number
    error?: string
  }> {
    return this.core.getMediaStream(options)
  }

  /**
   * 获取联系人昵称
   */
  async getDisplayNames(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.core.getDisplayNames(usernames)
  }

  /**
   * 获取头像 URL
   */
  async getAvatarUrls(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.core.getAvatarUrls(usernames)
  }

  /**
   * 获取群成员数量
   */
  async getGroupMemberCount(chatroomId: string): Promise<{ success: boolean; count?: number; error?: string }> {
    return this.core.getGroupMemberCount(chatroomId)
  }

  /**
   * 批量获取群成员数量
   */
  async getGroupMemberCounts(chatroomIds: string[]): Promise<{ success: boolean; map?: Record<string, number>; error?: string }> {
    return this.core.getGroupMemberCounts(chatroomIds)
  }

  /**
   * 获取群成员列表
   */
  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; members?: any[]; error?: string }> {
    return this.core.getGroupMembers(chatroomId)
  }

  // 获取群成员群名片昵称
  async getGroupNicknames(chatroomId: string): Promise<{ success: boolean; nicknames?: Record<string, string>; error?: string }> {
    return this.core.getGroupNicknames(chatroomId)
  }

  /**
   * 获取消息表列表
   */
  async getMessageTables(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }> {
    return this.core.getMessageTables(sessionId)
  }

  /**
   * 获取消息表统计
   */
  async getMessageTableStats(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }> {
    return this.core.getMessageTableStats(sessionId)
  }

  async getMessageDates(sessionId: string): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    return this.core.getMessageDates(sessionId)
  }

  async getChatDates(sessionIds: string[]): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    return this.core.getChatDates(sessionIds)
  }

  /**
   * 获取消息元数据
   */
  async getMessageMeta(dbPath: string, tableName: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.core.getMessageMeta(dbPath, tableName, limit, offset)
  }

  async getMessageTableColumns(dbPath: string, tableName: string): Promise<{ success: boolean; columns?: string[]; error?: string }> {
    return this.core.getMessageTableColumns(dbPath, tableName)
  }

  async getMessageTableTimeRange(dbPath: string, tableName: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getMessageTableTimeRange(dbPath, tableName)
  }

  /**
   * 获取联系人详情
   */
  async getContact(username: string): Promise<{ success: boolean; contact?: any; error?: string }> {
    return this.core.getContact(username)
  }

  /**
   * 批量获取联系人 extra_buffer 状态（isFolded/isMuted）
   */
  async getContactStatus(usernames: string[]): Promise<{ success: boolean; map?: Record<string, { isFolded: boolean; isMuted: boolean }>; error?: string }> {
    return this.core.getContactStatus(usernames)
  }

  async getContactTypeCounts(): Promise<{ success: boolean; counts?: { private: number; group: number; official: number; former_friend: number }; error?: string }> {
    return this.core.getContactTypeCounts()
  }

  async getContactsCompact(usernames: string[] = []): Promise<{ success: boolean; contacts?: any[]; error?: string }> {
    return this.core.getContactsCompact(usernames)
  }

  async getContactAliasMap(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.core.getContactAliasMap(usernames)
  }

  async getContactFriendFlags(usernames: string[]): Promise<{ success: boolean; map?: Record<string, boolean>; error?: string }> {
    return this.core.getContactFriendFlags(usernames)
  }

  async getChatRoomExtBuffer(chatroomId: string): Promise<{ success: boolean; extBuffer?: string; error?: string }> {
    return this.core.getChatRoomExtBuffer(chatroomId)
  }

  /**
   * 获取聚合统计数据
   */
  async getAggregateStats(sessionIds: string[], beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getAggregateStats(sessionIds, beginTimestamp, endTimestamp)
  }

  /**
   * 获取可用年份
   */
  async getAvailableYears(sessionIds: string[]): Promise<{ success: boolean; data?: number[]; error?: string }> {
    return this.core.getAvailableYears(sessionIds)
  }

  /**
   * 获取年度报告统计
   */
  async getAnnualReportStats(sessionIds: string[], beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getAnnualReportStats(sessionIds, beginTimestamp, endTimestamp)
  }

  /**
   * 获取年度报告扩展数据
   */
  async getAnnualReportExtras(sessionIds: string[], beginTimestamp: number, endTimestamp: number, peakDayBegin: number, peakDayEnd: number): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getAnnualReportExtras(sessionIds, beginTimestamp, endTimestamp, peakDayBegin, peakDayEnd)
  }

  /**
   * 获取双人报告统计数据
   */
  async getDualReportStats(sessionId: string, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getDualReportStats(sessionId, beginTimestamp, endTimestamp)
  }

  /**
   * 获取群聊统计
   */
  async getGroupStats(chatroomId: string, beginTimestamp: number = 0, endTimestamp: number = 0): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getGroupStats(chatroomId, beginTimestamp, endTimestamp)
  }

  /**
   * 打开消息游标
   */
  async openMessageCursor(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    return this.core.openMessageCursor(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)
  }

  /**
   * 打开轻量级消息游标
   */
  async openMessageCursorLite(sessionId: string, batchSize: number, ascending: boolean, beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; cursor?: number; error?: string }> {
    return this.core.openMessageCursorLite(sessionId, batchSize, ascending, beginTimestamp, endTimestamp)
  }

  /**
   * 获取下一批消息
   */
  async fetchMessageBatch(cursor: number): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    return this.core.fetchMessageBatch(cursor)
  }

  /**
   * 关闭消息游标
   */
  async closeMessageCursor(cursor: number): Promise<{ success: boolean; error?: string }> {
    return this.core.closeMessageCursor(cursor)
  }

  /**
   * 执行 SQL 查询（仅主进程内部使用：fallback/diagnostic/低频兼容）
   */
  async execQuery(kind: string, path: string | null, sql: string, params: any[] = []): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.core.execQuery(kind, path, sql, params)
  }

  /**
   * 获取表情包 CDN URL
   */
  async getEmoticonCdnUrl(dbPath: string, md5: string): Promise<{ success: boolean; url?: string; error?: string }> {
    return this.core.getEmoticonCdnUrl(dbPath, md5)
  }

  /**
   * 获取表情包释义
   */
  async getEmoticonCaption(dbPath: string, md5: string): Promise<{ success: boolean; caption?: string; error?: string }> {
    return this.core.getEmoticonCaption(dbPath, md5)
  }

  /**
   * 获取表情包释义（严格数据服务接口）
   */
  async getEmoticonCaptionStrict(md5: string): Promise<{ success: boolean; caption?: string; error?: string }> {
    return this.core.getEmoticonCaptionStrict(md5)
  }

  /**
   * 列出消息数据库
   */
  async listMessageDbs(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    return this.core.listMessageDbs()
  }

  /**
   * 列出媒体数据库
   */
  async listMediaDbs(): Promise<{ success: boolean; data?: string[]; error?: string }> {
    return this.core.listMediaDbs()
  }

  /**
   * 根据 ID 获取消息
   */
  async getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: any; error?: string }> {
    return this.core.getMessageById(sessionId, localId)
  }

  async searchMessages(keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    return this.core.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
  }

  /**
   * 获取语音数据
   */
  async getVoiceData(sessionId: string, createTime: number, candidates: string[], localId: number = 0, svrId: string | number = 0): Promise<{ success: boolean; hex?: string; error?: string }> {
    return this.core.getVoiceData(sessionId, createTime, candidates, localId, svrId)
  }

  async getVoiceDataBatch(
    requests: Array<{ session_id: string; create_time: number; local_id?: number; svr_id?: string | number; candidates?: string[] }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; hex?: string }>; error?: string }> {
    return this.core.getVoiceDataBatch(requests)
  }

  async getMediaSchemaSummary(dbPath: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getMediaSchemaSummary(dbPath)
  }

  async getHeadImageBuffers(usernames: string[]): Promise<{ success: boolean; map?: Record<string, string>; error?: string }> {
    return this.core.getHeadImageBuffers(usernames)
  }

  async resolveImageHardlink(md5: string, accountDir?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.resolveImageHardlink(md5, accountDir)
  }

  async resolveImageHardlinkBatch(
    requests: Array<{ md5: string; accountDir?: string }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }>; error?: string }> {
    return this.core.resolveImageHardlinkBatch(requests)
  }

  async resolveVideoHardlinkMd5(md5: string, dbPath?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.resolveVideoHardlinkMd5(md5, dbPath)
  }

  async resolveVideoHardlinkMd5Batch(
    requests: Array<{ md5: string; dbPath?: string }>
  ): Promise<{ success: boolean; rows?: Array<{ index: number; md5: string; success: boolean; data?: any; error?: string }>; error?: string }> {
    return this.core.resolveVideoHardlinkMd5Batch(requests)
  }

  /**
   * 获取朋友圈
   */
  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    return this.core.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)
  }

  /**
   * 获取朋友圈年度统计
   */
  async getSnsAnnualStats(beginTimestamp: number, endTimestamp: number): Promise<{ success: boolean; data?: any; error?: string }> {
    return this.core.getSnsAnnualStats(beginTimestamp, endTimestamp)
  }

  async getSnsUsernames(): Promise<{ success: boolean; usernames?: string[]; error?: string }> {
    return this.core.getSnsUsernames()
  }

  async getSnsExportStats(myWxid?: string): Promise<{ success: boolean; data?: { totalPosts: number; totalFriends: number; myPosts: number | null }; error?: string }> {
    return this.core.getSnsExportStats(myWxid)
  }

  async checkMessageAntiRevokeTriggers(
    sessionIds: string[]
  ): Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; installed?: boolean; error?: string }>; error?: string }> {
    return this.core.checkMessageAntiRevokeTriggers(sessionIds)
  }

  async installMessageAntiRevokeTriggers(
    sessionIds: string[]
  ): Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; alreadyInstalled?: boolean; error?: string }>; error?: string }> {
    return this.core.installMessageAntiRevokeTriggers(sessionIds)
  }

  async uninstallMessageAntiRevokeTriggers(
    sessionIds: string[]
  ): Promise<{ success: boolean; rows?: Array<{ sessionId: string; success: boolean; error?: string }>; error?: string }> {
    return this.core.uninstallMessageAntiRevokeTriggers(sessionIds)
  }

  /**
   * 安装朋友圈删除拦截
   */
  async installSnsBlockDeleteTrigger(): Promise<{ success: boolean; alreadyInstalled?: boolean; error?: string }> {
    return this.core.installSnsBlockDeleteTrigger()
  }

  /**
   * 卸载朋友圈删除拦截
   */
  async uninstallSnsBlockDeleteTrigger(): Promise<{ success: boolean; error?: string }> {
    return this.core.uninstallSnsBlockDeleteTrigger()
  }

  /**
   * 查询朋友圈删除拦截是否已安装
   */
  async checkSnsBlockDeleteTrigger(): Promise<{ success: boolean; installed?: boolean; error?: string }> {
    return this.core.checkSnsBlockDeleteTrigger()
  }

  /**
   * 从数据库直接删除朋友圈记录
   */
  async deleteSnsPost(postId: string): Promise<{ success: boolean; error?: string }> {
    return this.core.deleteSnsPost(postId)
  }

  /**
   * 获取数据服务内部日志
   */
  async getLogs(): Promise<{ success: boolean; logs?: string[]; error?: string }> {
    return this.core.getLogs()
  }

  /**
   * 验证 Windows Hello
   */
  async verifyUser(message: string, hwnd?: string): Promise<{ success: boolean; error?: string }> {
    return this.core.verifyUser(message, hwnd)
  }

  /**
   * 修改消息内容
   */
  async updateMessage(sessionId: string, localId: number, createTime: number, newContent: string): Promise<{ success: boolean; error?: string }> {
    return this.core.updateMessage(sessionId, localId, createTime, newContent)
  }

  /**
   * 删除消息
   */
  async deleteMessage(sessionId: string, localId: number, createTime: number, dbPathHint?: string): Promise<{ success: boolean; error?: string }> {
    return this.core.deleteMessage(sessionId, localId, createTime, dbPathHint)
  }

  /**
   * 数据收集：初始化
   */
  async cloudInit(intervalSeconds: number): Promise<{ success: boolean; error?: string }> {
    return this.core.cloudInit(intervalSeconds)
  }

  /**
   * 数据收集：上报数据
   */
  async cloudReport(statsJson: string): Promise<{ success: boolean; error?: string }> {
    return this.core.cloudReport(statsJson)
  }

  /**
   * 数据收集：停止
   */
  cloudStop(): Promise<{ success: boolean; error?: string }> {
    return this.core.cloudStop()
  }
}

export const wcdbService = new WcdbService()

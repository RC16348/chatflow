import { wcdbService } from './wcdbService'
import { simpleInfo, simpleDebug, simpleError } from './simpleDebugLog'

export interface ContactInfo {
  username: string
  nickname: string
  remark: string
  avatarUrl?: string
  type?: number
}

export interface Message {
  messageKey: string
  localId: number
  serverId: number
  createTime: number
  isSend: number | null
  senderUsername: string | null
  content: string
  type?: number
  voiceDurationSeconds?: number
}

export interface GroupInfo {
  username: string
  displayName: string
  memberCount: number
}

export interface SnsPost {
  contentDesc: string
  createTime: number
  likes?: any[]
  comments?: any[]
  location?: { poiName?: string }
}

interface RuntimeConfig {
  dbPath?: string
  decryptKey?: string
  myWxid?: string
}

class ChatServiceCore {
  private config: RuntimeConfig = {}

  setRuntimeConfig(config: RuntimeConfig) {
    this.config = config
  }

  async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    if (!this.config.dbPath || !this.config.decryptKey || !this.config.myWxid) {
      return { success: false, error: '配置不完整' }
    }

    const isConnected = await wcdbService.isConnected()
    if (isConnected) {
      return { success: true }
    }

    const opened = await wcdbService.open(this.config.dbPath, this.config.decryptKey, this.config.myWxid)
    if (!opened) {
      const error = await wcdbService.getLastInitError()
      return { success: false, error: error || '数据库连接失败' }
    }

    return { success: true }
  }

  async getContacts(options?: { lite?: boolean }): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getSessions()
      if (!result.success || !result.sessions) {
        return { success: false, error: result.error || '获取会话失败' }
      }

      const contacts: ContactInfo[] = result.sessions
        .filter((s: any) => s.username && !s.username.endsWith('@chatroom'))
        .map((s: any) => ({
          username: s.username,
          nickname: s.displayName || s.username,
          remark: s.remark || '',
          avatarUrl: s.avatarUrl,
          type: s.type
        }))

      return { success: true, contacts }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getGroupChats(): Promise<{ success: boolean; data?: GroupInfo[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getSessions()
      if (!result.success || !result.sessions) {
        return { success: false, error: result.error || '获取会话失败' }
      }

      const groups: GroupInfo[] = result.sessions
        .filter((s: any) => s.username && s.username.endsWith('@chatroom'))
        .map((s: any) => ({
          username: s.username,
          displayName: s.displayName || s.username,
          memberCount: s.memberCount || 0
        }))

      return { success: true, data: groups }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 100,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      let messages: Message[] = []

      // 如果指定了时间范围，使用游标 API 获取该时间范围内的消息
      if (startTime || endTime) {
        const beginTimestamp = startTime ? Math.floor(startTime) : 0
        const endTimestamp = endTime ? Math.floor(endTime) : Math.floor(Date.now() / 1000)

        const cursorResult = await wcdbService.openMessageCursor(
          sessionId,
          limit,
          false, // descending (最新的在前)
          beginTimestamp,
          endTimestamp
        )

        if (!cursorResult.success || !cursorResult.cursor) {
          return { success: false, error: cursorResult.error || '打开消息游标失败' }
        }

        const cursor = cursorResult.cursor
        try {
          const batchResult = await wcdbService.fetchMessageBatch(cursor)
          if (batchResult.success && batchResult.rows) {
            messages = batchResult.rows.map((m: any) => ({
              messageKey: m.messageKey || `${sessionId}_${m.localId}`,
              localId: m.localId,
              serverId: m.serverId,
              createTime: m.createTime,
              isSend: m.isSend,
              senderUsername: m.senderUsername,
              content: m.parsedContent || m.content || '',
              type: m.type,
              voiceDurationSeconds: m.voiceDurationSeconds
            }))
          }
        } finally {
          await wcdbService.closeMessageCursor(cursor)
        }
      } else {
        // 没有时间范围，使用普通 API
        const result = await wcdbService.getMessages(sessionId, limit, offset)
        if (!result.success || !result.messages) {
          return { success: false, error: result.error || '获取消息失败' }
        }

        messages = result.messages.map((m: any) => ({
          messageKey: m.messageKey || `${sessionId}_${m.localId}`,
          localId: m.localId,
          serverId: m.serverId,
          createTime: m.createTime,
          isSend: m.isSend,
          senderUsername: m.senderUsername,
          content: m.parsedContent || m.content || '',
          type: m.type,
          voiceDurationSeconds: m.voiceDurationSeconds
        }))
      }

      return { success: true, messages }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getLatestMessages(sessionId: string, limit: number = 20): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getMessages(sessionId, limit, 0)
      if (!result.success || !result.messages) {
        return { success: false, error: result.error || '获取消息失败' }
      }

      const messages = result.messages.map((m: any) => ({
        messageKey: m.messageKey || `${sessionId}_${m.localId}`,
        localId: m.localId,
        serverId: m.serverId,
        createTime: m.createTime,
        isSend: m.isSend,
        senderUsername: m.senderUsername,
        content: m.parsedContent || m.content || '',
        type: m.type,
        voiceDurationSeconds: m.voiceDurationSeconds
      }))

      return { success: true, messages }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async searchMessages(
    keyword: string,
    sessionId?: string,
    limit: number = 20,
    offset?: number,
    beginTimestamp?: number,
    endTimestamp?: number
  ): Promise<{ success: boolean; messages?: any[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.searchMessages(keyword, sessionId, limit, offset || 0, beginTimestamp, endTimestamp)
      if (!result.success || !result.messages) {
        return { success: false, error: result.error || '搜索失败' }
      }

      return { success: true, messages: result.messages }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getTimeline(limit: number, offset: number, usernames?: string[]): Promise<{ success: boolean; timeline?: SnsPost[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getTimeline(limit, offset, usernames)
      if (!result.success) {
        return { success: false, error: result.error || '获取朋友圈失败' }
      }

      return { success: true, timeline: result.timeline || [] }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getAllVoiceMessages(sessionId: string): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getResourceMessages({
        sessionId,
        types: ['voice'],
        limit: 1000
      })
      if (!result.success || !result.messages) {
        return { success: false, error: result.error || '获取语音消息失败' }
      }

      const messages = result.messages.map((m: any) => ({
        messageKey: m.messageKey || `${sessionId}_${m.localId}`,
        localId: m.localId,
        serverId: m.serverId,
        createTime: m.createTime,
        isSend: m.isSend,
        senderUsername: m.senderUsername,
        content: m.parsedContent || m.content || '',
        type: m.type,
        voiceDurationSeconds: m.voiceDurationSeconds
      }))

      return { success: true, messages }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getVoiceTranscript(sessionId: string, msgId: string, createTime?: number): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getVoiceTranscript(sessionId, msgId, createTime)
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getMessageDateCounts(sessionId: string): Promise<{ success: boolean; counts?: Record<string, number>; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getMessageDateCounts(sessionId)
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getExportSessionStats(sessionIds: string[], options?: any): Promise<{ success: boolean; data?: any; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const normalizedSessionIds = Array.from(
        new Set(
          (sessionIds || [])
            .map((id: string) => String(id || '').trim())
            .filter(Boolean)
        )
      )

      if (normalizedSessionIds.length === 0) {
        return { success: true, data: {} }
      }

      simpleInfo(`[getExportSessionStats] 开始计算 ${normalizedSessionIds.length} 个会话的统计`)

      const resultMap: Record<string, any> = {}

      // 获取群人数统计
      const groupSessionIds = normalizedSessionIds.filter(id => id.endsWith('@chatroom'))
      const privateSessionIds = normalizedSessionIds.filter(id => !id.endsWith('@chatroom'))
      let memberCountMap: Record<string, number> = {}
      if (groupSessionIds.length > 0) {
        const memberCountsResult = await wcdbService.getGroupMemberCounts(groupSessionIds)
        if (memberCountsResult.success && memberCountsResult.map) {
          memberCountMap = memberCountsResult.map
        }
      }

      // 计算共同群聊和共同好友
      const includeRelations = options?.includeRelations !== false
      let privateMutualGroupMap: Record<string, number> = {}
      let groupMutualFriendMap: Record<string, number> = {}

      if (includeRelations) {
        // 如果有私聊，需要获取所有群聊来计算共同群聊数
        let allGroupSessionIds = groupSessionIds
        if (privateSessionIds.length > 0) {
          try {
            const sessionsResult = await wcdbService.getSessions()
            if (sessionsResult.success && Array.isArray(sessionsResult.sessions)) {
              const allGroups = new Set<string>()
              for (const rowAny of sessionsResult.sessions) {
                const row = rowAny as Record<string, unknown>
                const usernameRaw = row.username ?? row.userName ?? row.talker ?? row.sessionId
                const username = String(usernameRaw || '').trim()
                if (username && username.endsWith('@chatroom')) {
                  allGroups.add(username)
                }
              }
              allGroupSessionIds = Array.from(allGroups)
              simpleInfo(`[getExportSessionStats] 获取到 ${allGroupSessionIds.length} 个群聊用于计算共同群聊`)
            }
          } catch (e) {
            simpleError(`[getExportSessionStats] 获取所有群聊失败:`, e)
          }
        }

        simpleInfo(`[getExportSessionStats] 计算关系统计: ${allGroupSessionIds.length} 个群聊, ${privateSessionIds.length} 个私聊`)
        try {
          const relationResult = await this.buildGroupRelationStats(allGroupSessionIds, privateSessionIds)
          privateMutualGroupMap = relationResult.privateMutualGroupMap
          groupMutualFriendMap = relationResult.groupMutualFriendMap
          simpleInfo(`[getExportSessionStats] 关系统计计算完成`)
        } catch (e) {
          simpleError(`[getExportSessionStats] 计算关系统计失败:`, e)
        }
      }

      for (const sessionId of normalizedSessionIds) {
        const nativeResult = await wcdbService.getSessionMessageTypeStats(sessionId, 0, 0)
        if (nativeResult.success && nativeResult.data) {
          const data = nativeResult.data as Record<string, any>
          const isGroup = sessionId.endsWith('@chatroom')
          const stats: any = {
            totalMessages: Math.max(0, Math.floor(Number(data.total_messages || 0))),
            voiceMessages: Math.max(0, Math.floor(Number(data.voice_messages || 0))),
            imageMessages: Math.max(0, Math.floor(Number(data.image_messages || 0))),
            videoMessages: Math.max(0, Math.floor(Number(data.video_messages || 0))),
            emojiMessages: Math.max(0, Math.floor(Number(data.emoji_messages || 0))),
            callMessages: Math.max(0, Math.floor(Number(data.call_messages || 0))),
            transferMessages: Math.max(0, Math.floor(Number(data.transfer_messages || 0))),
            redPacketMessages: Math.max(0, Math.floor(Number(data.red_packet_messages || 0)))
          }

          const firstTs = Math.max(0, Math.floor(Number(data.first_timestamp || 0)))
          const lastTs = Math.max(0, Math.floor(Number(data.last_timestamp || 0)))
          if (firstTs > 0) stats.firstTimestamp = firstTs
          if (lastTs > 0) stats.lastTimestamp = lastTs

          if (isGroup) {
            stats.groupMyMessages = Math.max(0, Math.floor(Number(data.group_my_messages || 0)))
            stats.groupActiveSpeakers = Math.max(0, Math.floor(Number(data.group_sender_count || 0)))
            // 添加群人数统计
            stats.groupMemberCount = typeof memberCountMap[sessionId] === 'number'
              ? Math.max(0, Math.floor(memberCountMap[sessionId]))
              : 0
            // 添加群共同好友数
            stats.groupMutualFriends = groupMutualFriendMap[sessionId] || 0
            stats.privateMutualGroups = 0
          } else {
            // 添加共同群聊数
            stats.privateMutualGroups = privateMutualGroupMap[sessionId] || 0
            stats.groupMutualFriends = 0
          }

          resultMap[sessionId] = stats
        } else {
          const isGroup = sessionId.endsWith('@chatroom')
          const emptyStats: any = {
            totalMessages: 0,
            voiceMessages: 0,
            imageMessages: 0,
            videoMessages: 0,
            emojiMessages: 0,
            callMessages: 0,
            transferMessages: 0,
            redPacketMessages: 0
          }
          if (isGroup) {
            emptyStats.groupMemberCount = typeof memberCountMap[sessionId] === 'number'
              ? Math.max(0, Math.floor(memberCountMap[sessionId]))
              : 0
            emptyStats.groupMutualFriends = groupMutualFriendMap[sessionId] || 0
            emptyStats.privateMutualGroups = 0
          } else {
            emptyStats.privateMutualGroups = privateMutualGroupMap[sessionId] || 0
            emptyStats.groupMutualFriends = 0
          }
          resultMap[sessionId] = emptyStats
        }
      }

      simpleInfo(`[getExportSessionStats] 完成 ${normalizedSessionIds.length} 个会话的统计`)
      return { success: true, data: resultMap }
    } catch (error) {
      simpleError(`[getExportSessionStats] 错误:`, error)
      return { success: false, error: String(error) }
    }
  }

  /**
   * 构建群聊关系统计（共同群聊、群共同好友）
   */
  private async buildGroupRelationStats(
    groupSessionIds: string[],
    privateSessionIds: string[]
  ): Promise<{
    privateMutualGroupMap: Record<string, number>
    groupMutualFriendMap: Record<string, number>
  }> {
    const privateMutualGroupMap: Record<string, number> = {}
    const groupMutualFriendMap: Record<string, number> = {}

    simpleInfo(`[buildGroupRelationStats] 开始计算: ${groupSessionIds.length} 个群聊, ${privateSessionIds.length} 个私聊`)

    if (groupSessionIds.length === 0) {
      simpleInfo('[buildGroupRelationStats] 没有群聊，直接返回')
      // 初始化私聊的共同群聊数为0
      for (const sessionId of privateSessionIds) {
        privateMutualGroupMap[sessionId] = 0
      }
      return { privateMutualGroupMap, groupMutualFriendMap }
    }

    // 获取自己的身份标识
    const selfIdentitySet = new Set<string>()
    if (this.config.myWxid) {
      selfIdentitySet.add(this.config.myWxid.toLowerCase())
      // 添加可能的变体格式
      const cleaned = this.cleanAccountDirName(this.config.myWxid)
      if (cleaned !== this.config.myWxid) {
        selfIdentitySet.add(cleaned.toLowerCase())
      }
    }

    // 构建私聊索引
    const privateIndex = new Map<string, Set<string>>()
    for (const sessionId of privateSessionIds) {
      const keys = this.buildIdentityKeys(sessionId)
      for (const key of keys) {
        const set = privateIndex.get(key) || new Set<string>()
        set.add(sessionId)
        privateIndex.set(key, set)
      }
      privateMutualGroupMap[sessionId] = 0
    }
    simpleInfo(`[buildGroupRelationStats] 私聊索引构建完成: ${privateIndex.size} 个键`)

    // 获取好友身份集
    const friendIdentitySet = await this.getFriendIdentitySet()
    simpleInfo(`[buildGroupRelationStats] 好友身份集大小: ${friendIdentitySet.size}`)

    // 处理每个群聊
    for (const groupId of groupSessionIds) {
      try {
        simpleInfo(`[buildGroupRelationStats] 处理群聊: ${groupId}`)

        // 获取群成员
        const membersResult = await wcdbService.getGroupMembers(groupId)
        if (!membersResult.success || !membersResult.members) {
          simpleError(`[buildGroupRelationStats] 获取群 ${groupId} 成员失败: ${membersResult.error}`)
          groupMutualFriendMap[groupId] = 0
          continue
        }

        const members = membersResult.members
        simpleInfo(`[buildGroupRelationStats] 群 ${groupId} 有 ${members.length} 个成员`)

        const touchedPrivateSessions = new Set<string>()
        let friendCount = 0

        for (const member of members) {
          const username = this.extractGroupMemberUsername(member)
          if (!username) continue

          // 跳过自己
          const identityKeys = this.buildIdentityKeys(username)
          const canonical = identityKeys[0]
          if (selfIdentitySet.has(canonical.toLowerCase())) continue

          // 检查是否为好友
          let isFriend = false
          for (const key of identityKeys) {
            if (friendIdentitySet.has(key)) {
              isFriend = true
              break
            }
          }
          if (isFriend) {
            friendCount++
          }

          // 查找匹配的私聊会话
          for (const key of identityKeys) {
            const linked = privateIndex.get(key)
            if (linked) {
              for (const sessionId of linked) {
                touchedPrivateSessions.add(sessionId)
              }
            }
          }
        }

        groupMutualFriendMap[groupId] = friendCount
        simpleInfo(`[buildGroupRelationStats] 群 ${groupId}: 共同好友=${friendCount}, 匹配私聊=${touchedPrivateSessions.size}`)

        // 更新私聊的共同群聊数
        for (const sessionId of touchedPrivateSessions) {
          privateMutualGroupMap[sessionId] = (privateMutualGroupMap[sessionId] || 0) + 1
        }
      } catch (e) {
        simpleError(`[buildGroupRelationStats] 处理群 ${groupId} 失败:`, e)
        groupMutualFriendMap[groupId] = 0
      }
    }

    simpleInfo(`[buildGroupRelationStats] 完成`)
    return { privateMutualGroupMap, groupMutualFriendMap }
  }

  /**
   * 从群成员数据中提取用户名
   */
  private extractGroupMemberUsername(member: any): string | null {
    if (!member) return null
    const username = member.username || member.user_name || member.userName || member.wxid
    if (typeof username === 'string' && username.trim()) {
      return username.trim()
    }
    return null
  }

  /**
   * 构建身份标识键
   */
  private buildIdentityKeys(username: string): string[] {
    const keys = new Set<string>()
    if (!username) return []

    const normalized = username.trim().toLowerCase()
    keys.add(normalized)

    // 清理后的格式（去除后缀）
    const cleaned = this.cleanAccountDirName(normalized)
    if (cleaned !== normalized) {
      keys.add(cleaned)
    }

    return Array.from(keys)
  }

  /**
   * 清理账号目录名（去除后缀）
   */
  private cleanAccountDirName(name: string): string {
    if (!name) return ''
    const normalized = name.trim().toLowerCase()

    // 处理 wxid_xxx_xxxx 格式
    if (normalized.startsWith('wxid_')) {
      const parts = normalized.split('_')
      if (parts.length >= 3) {
        return `wxid_${parts[1]}`
      }
    }

    return normalized
  }

  /**
   * 获取好友身份标识集
   */
  private async getFriendIdentitySet(): Promise<Set<string>> {
    const identities = new Set<string>()

    try {
      const contactResult = await wcdbService.getContactsCompact()
      if (!contactResult.success || !contactResult.contacts) {
        return identities
      }

      for (const row of contactResult.contacts as Record<string, any>[]) {
        // 判断是否为好友：localType === 1 或 (localType === 0 且 quanPin 不为空)
        const localType = Number(row.local_type || row.localType || 0)
        const quanPin = String(row.quan_pin || row.quanPin || '').trim()

        const isValidContact = localType === 1 || (localType === 0 && quanPin)
        if (!isValidContact) continue

        // 收集所有可能的用户名
        const usernames = [
          row.username,
          row.user_name,
          row.userName,
          row.encrypt_username,
          row.encryptUsername,
          row.encrypt_user_name,
          row.encryptUserName,
          row.alias
        ].filter(Boolean) as string[]

        for (const name of usernames) {
          if (!name) continue
          if (name.includes('@chatroom')) continue
          if (name.startsWith('gh_')) continue

          for (const key of this.buildIdentityKeys(name)) {
            identities.add(key)
          }
        }
      }
    } catch (e) {
      simpleError('[getFriendIdentitySet] 获取好友身份集失败:', e)
    }

    return identities
  }

  async getOverallStatistics(): Promise<{ success: boolean; data?: any; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getOverallStatistics()
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getTimeDistribution(): Promise<{ success: boolean; data?: any; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getTimeDistribution()
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getContactRankings(limit?: number): Promise<{ success: boolean; data?: any; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getContactRankings(limit)
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getGroupMessageRanking(chatroomId: string, limit?: number): Promise<{ success: boolean; data?: any; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getGroupMessageRanking(chatroomId, limit)
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async getGroupActiveHours(chatroomId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    const connectResult = await this.ensureConnected()
    if (!connectResult.success) {
      return { success: false, error: connectResult.error }
    }

    try {
      const result = await wcdbService.getGroupActiveHours(chatroomId)
      return result
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }
}

export const chatServiceCore = new ChatServiceCore()

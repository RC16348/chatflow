import { parentPort, workerData } from 'worker_threads'
import { wcdbService } from './services/wcdbService'
import { chatServiceCore } from './services/chatServiceCore'

interface AIToolsWorkerConfig {
  toolName: string
  args: any
  dbPath?: string
  decryptKey?: string
  myWxid?: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

const config = workerData as AIToolsWorkerConfig
process.env.CHATFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}
if (config.userDataPath) {
  process.env.CHATFLOW_USER_DATA_PATH = config.userDataPath
  process.env.CHATFLOW_CONFIG_CWD = config.userDataPath
}
process.env.CHATFLOW_PROJECT_NAME = process.env.CHATFLOW_PROJECT_NAME || 'ChatFlow'

async function run() {
  // 设置服务
  wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
  wcdbService.setLogEnabled(config.logEnabled === true)

  // 设置聊天服务配置
  chatServiceCore.setRuntimeConfig({
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    myWxid: config.myWxid
  })

  let result: any

  try {
    switch (config.toolName) {
      case 'chat_summary':
        result = await executeChatSummary(config.args)
        break
      case 'smart_search':
        result = await executeSmartSearch(config.args)
        break
      case 'reply_suggestion':
        result = await executeReplySuggestion(config.args)
        break
      case 'sns_analysis':
        result = await executeSnsAnalysis(config.args)
        break
      case 'group_role_analysis':
        result = await executeGroupRoleAnalysis(config.args)
        break
      case 'emotion_calendar':
        result = await executeEmotionCalendar(config.args)
        break
      case 'voice_summary':
        result = await executeVoiceSummary(config.args)
        break
      case 'relationship_timeline':
        result = await executeRelationshipTimeline(config.args)
        break
      case 'chat_style_profile':
        result = await executeChatStyleProfile(config.args)
        break
      case 'message_classification':
        result = await executeMessageClassification(config.args)
        break
      case 'list_all_contacts':
        result = await executeListAllContacts(config.args)
        break
      case 'list_all_groups':
        result = await executeListAllGroups(config.args)
        break
      default:
        throw new Error(`未知工具: ${config.toolName}`)
    }

    parentPort?.postMessage({
      type: 'tool:result',
      data: result
    })
  } catch (error) {
    parentPort?.postMessage({
      type: 'tool:error',
      error: String(error)
    })
  }
}

// 工具执行函数
async function executeChatSummary(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })
  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人失败' }
  }

  const contacts = result.contacts || []
  const searchName = args.contactName.toLowerCase().trim()

  // 查找联系人
  let contact = contacts.find((c: any) =>
    c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
  )

  if (!contact) {
    contact = contacts.find((c: any) =>
      c.nickname?.toLowerCase() === searchName ||
      c.remark?.toLowerCase() === searchName
    )
  }

  if (!contact) {
    contact = contacts.find((c: any) =>
      c.nickname?.toLowerCase().includes(searchName) ||
      c.remark?.toLowerCase().includes(searchName)
    )
  }

  if (!contact) {
    return { success: false, error: `未找到联系人"${args.contactName}"` }
  }

  // 计算时间范围
  let startTime = 0, endTime = Date.now() / 1000
  const now = new Date()
  switch (args.timeRange) {
    case 'today':
      startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
      break
    case 'this_week':
      startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000
      break
    case 'this_month':
      startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
      break
    case 'this_year':
      startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000
      break
    case 'custom':
      if (args.startDate) startTime = new Date(args.startDate).getTime() / 1000
      if (args.endDate) endTime = new Date(args.endDate + 'T23:59:59').getTime() / 1000
      break
  }

  const limit = args.maxMessages || 200
  const messagesResult = await chatServiceCore.getMessages(contact.username, 0, limit, startTime, endTime)
  const messages = messagesResult?.messages || []

  if (!messages || messages.length === 0) {
    return { success: false, error: '该时间段内没有聊天记录' }
  }

  return {
    success: true,
    data: {
      contactName: contact.remark || contact.nickname || contact.username,
      username: contact.username,
      timeRange: args.timeRange || 'all',
      totalMessages: messages.length,
      timeSpan: {
        first: messages[0]?.createTime ? new Date(messages[0].createTime * 1000).toLocaleString('zh-CN') : '',
        last: messages[messages.length - 1]?.createTime ? new Date(messages[messages.length - 1].createTime * 1000).toLocaleString('zh-CN') : ''
      },
      sampleMessages: messages
        .filter((m: any) => m.content && typeof m.content === 'string' && m.content.length > 2)
        .slice(0, 50)
        .map((m: any) => ({
          sender: m.isSend ? '我' : '对方',
          content: m.content.slice(0, 200),
          time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
        }))
    }
  }
}

async function executeSmartSearch(args: any) {
  const limit = args.limit || 20
  const resultsResult = await chatServiceCore.searchMessages(args.query, args.contactName || '', limit)
  const results = resultsResult?.messages || []

  if (!results || results.length === 0) {
    return { success: false, error: '未找到相关消息' }
  }

  return {
    success: true,
    data: {
      query: args.query,
      totalResults: results.length,
      messages: results.slice(0, limit).map((m: any) => ({
        contactName: m.talker || '',
        content: m.content?.slice(0, 300) || '',
        time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
      }))
    }
  }
}

async function executeReplySuggestion(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })
  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人失败' }
  }

  const contacts = result.contacts || []
  const searchName = args.contactName.toLowerCase().trim()

  let contact = contacts.find((c: any) =>
    c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
  )

  if (!contact) {
    contact = contacts.find((c: any) =>
      c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
    )
  }

  if (!contact) {
    return { success: false, error: `未找到联系人"${args.contactName}"` }
  }

  const messagesResult = await chatServiceCore.getLatestMessages(contact.username, args.contextCount || 20)
  const messages = messagesResult?.messages || []

  if (!messages || messages.length === 0) {
    return { success: false, error: '没有最近的聊天记录' }
  }

  return {
    success: true,
    data: {
      contactName: contact.remark || contact.nickname || contact.username,
      recentMessages: messages.map((m: any) => ({
        sender: m.isSend ? '我' : (contact.remark || contact.nickname || '对方'),
        content: m.content?.slice(0, 300) || '[非文本消息]',
        time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''
      }))
    }
  }
}

async function executeSnsAnalysis(args: any) {
  const contactsResult = await chatServiceCore.getContacts({ lite: true })
  let targetUsername = args.contactName

  if (contactsResult?.success) {
    const contacts = contactsResult.contacts || []
    const searchName = args.contactName.toLowerCase().trim()
    const contact = contacts.find((c: any) =>
      c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
    ) || contacts.find((c: any) =>
      c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
    )
    if (contact?.username) {
      targetUsername = contact.username
    }
  }

  const result = await chatServiceCore.getTimeline(args.limit || 30, 0, [targetUsername])
  const posts = result?.timeline || []

  if (!posts || posts.length === 0) {
    return { success: false, error: `未找到"${args.contactName}"的朋友圈内容` }
  }

  return {
    success: true,
    data: {
      contactName: args.contactName,
      totalPosts: posts.length,
      posts: posts.map((p: any) => ({
        content: p.contentDesc?.slice(0, 200) || '',
        time: p.createTime ? new Date(p.createTime * 1000).toLocaleString('zh-CN') : '',
        likesCount: p.likes?.length || 0,
        commentsCount: p.comments?.length || 0,
        location: p.location?.poiName || ''
      }))
    }
  }
}

async function executeGroupRoleAnalysis(args: any) {
  const result = await chatServiceCore.getGroupChats()
  const groups = result?.data || []

  const searchName = args.groupName.toLowerCase()
  const group = groups.find((g: any) =>
    g.displayName?.toLowerCase() === searchName || g.username === args.groupName
  ) || groups.find((g: any) => g.displayName?.toLowerCase().includes(searchName))

  if (!group) {
    return { success: false, error: `未找到群聊"${args.groupName}"` }
  }

  const rankingsResult = await chatServiceCore.getGroupMessageRanking(group.username, args.topMembers || 10)
  const rankings = rankingsResult?.data || []

  const activeHoursResult = await chatServiceCore.getGroupActiveHours(group.username)
  const activeHours = activeHoursResult?.data?.hourlyDistribution || {}

  return {
    success: true,
    data: {
      groupName: group.displayName || args.groupName,
      chatroomId: group.username,
      memberCount: group.memberCount || 0,
      topMembers: rankings.map((r: any) => ({
        name: r.member?.displayName || r.member?.username,
        messageCount: r.messageCount || 0
      })),
      activeHours
    }
  }
}

async function executeEmotionCalendar(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })
  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人失败' }
  }

  const contacts = result.contacts || []
  const searchName = args.contactName.toLowerCase().trim()

  let contact = contacts.find((c: any) =>
    c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase().includes(searchName) || c.remark?.toLowerCase().includes(searchName)
  )

  if (!contact) {
    return { success: false, error: `未找到联系人"${args.contactName}"` }
  }

  const dateCountsResult = await chatServiceCore.getMessageDateCounts(contact.username)
  const dateCounts = dateCountsResult?.counts || {}

  const month = args.month || new Date().toISOString().slice(0, 7)
  const filtered = Object.entries(dateCounts)
    .filter(([date]) => date.startsWith(month))
    .map(([date, count]) => ({ date, count }))

  return {
    success: true,
    data: {
      contactName: contact.remark || contact.nickname || contact.username,
      month,
      dailyMessageCounts: filtered,
      totalMessages: filtered.reduce((sum: number, d: any) => sum + (d.count || 0), 0),
      activeDays: filtered.filter((d: any) => d.count > 0).length
    }
  }
}

async function executeVoiceSummary(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })
  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人失败' }
  }

  const contacts = result.contacts || []
  const searchName = args.contactName.toLowerCase().trim()

  let contact = contacts.find((c: any) =>
    c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase().includes(searchName) || c.remark?.toLowerCase().includes(searchName)
  )

  if (!contact) {
    return { success: false, error: `未找到联系人"${args.contactName}"` }
  }

  const voiceMessagesResult = await chatServiceCore.getAllVoiceMessages(contact.username)
  const voiceMessages = voiceMessagesResult?.messages || []
  const limit = args.limit || 10
  const recentVoices = voiceMessages.slice(0, limit)

  if (recentVoices.length === 0) {
    return { success: false, error: `与"${contact.remark || contact.nickname || contact.username}"没有语音消息` }
  }

  const transcripts = []
  for (const v of recentVoices) {
    try {
      const transcriptResult = await chatServiceCore.getVoiceTranscript(contact.username, String(v.localId), v.createTime)
      if (transcriptResult?.success && transcriptResult.transcript) {
        transcripts.push({
          time: v.createTime ? new Date(v.createTime * 1000).toLocaleString('zh-CN') : '',
          transcript: transcriptResult.transcript,
          duration: (v as any).voiceDurationSeconds || 0
        })
      }
    } catch {
      transcripts.push({
        time: v.createTime ? new Date(v.createTime * 1000).toLocaleString('zh-CN') : '',
        transcript: '[转写失败]',
        duration: (v as any).voiceDurationSeconds || 0
      })
    }
  }

  return {
    success: true,
    data: {
      contactName: contact.remark || contact.nickname || contact.username,
      totalVoices: recentVoices.length,
      transcripts
    }
  }
}

async function executeRelationshipTimeline(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })
  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人失败' }
  }

  const contacts = result.contacts || []
  const searchName = args.contactName.toLowerCase().trim()

  let contact = contacts.find((c: any) =>
    c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase().includes(searchName) || c.remark?.toLowerCase().includes(searchName)
  )

  if (!contact) {
    return { success: false, error: `未找到联系人"${args.contactName}"` }
  }

  const year = args.year || new Date().getFullYear()
  const statsResult = await chatServiceCore.getExportSessionStats([contact.username], {})
  const stats = statsResult?.data?.[contact.username] || {}

  const dateCountsResult = await chatServiceCore.getMessageDateCounts(contact.username)
  const dateCounts = dateCountsResult?.counts || {}

  const yearStr = year.toString()
  const monthlyData: Record<string, number> = {}
  Object.entries(dateCounts).forEach(([date, count]) => {
    if (date.startsWith(yearStr)) {
      const month = date.slice(0, 7)
      monthlyData[month] = (monthlyData[month] || 0) + (count as number)
    }
  })

  return {
    success: true,
    data: {
      contactName: contact.remark || contact.nickname || contact.username,
      year,
      totalMessages: (stats as any)?.totalMessages || 0,
      monthlyData: Object.entries(monthlyData).map(([month, count]) => ({ month, count })),
      stats
    }
  }
}

async function executeChatStyleProfile(args: any) {
  const [overallStatsResult, timeDistResult, rankingsResult] = await Promise.all([
    chatServiceCore.getOverallStatistics(),
    chatServiceCore.getTimeDistribution(),
    chatServiceCore.getContactRankings(10)
  ])

  const overallStats = overallStatsResult?.data || {}
  const timeDist = timeDistResult?.data || {}
  const rankings = rankingsResult?.data || []

  let contactStats = null
  if (args.analysisType === 'contact' && args.contactName) {
    const contactsResult = await chatServiceCore.getContacts({ lite: true })
    if (contactsResult?.success) {
      const contacts = contactsResult.contacts || []
      const searchName = args.contactName.toLowerCase().trim()
      const contact = contacts.find((c: any) =>
        c.nickname === args.contactName || c.remark === args.contactName
      ) || contacts.find((c: any) =>
        c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
      )

      if (contact) {
        const statsResult = await chatServiceCore.getExportSessionStats([contact.username], {})
        contactStats = statsResult?.data?.[contact.username] || {}
      }
    }
  }

  return {
    success: true,
    data: {
      overall: overallStats,
      timeDistribution: timeDist,
      topContacts: rankings,
      contactStats
    }
  }
}

async function executeMessageClassification(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })
  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人失败' }
  }

  const contacts = result.contacts || []
  const searchName = args.contactName.toLowerCase().trim()

  let contact = contacts.find((c: any) =>
    c.nickname === args.contactName || c.remark === args.contactName || c.username === args.contactName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase() === searchName || c.remark?.toLowerCase() === searchName
  ) || contacts.find((c: any) =>
    c.nickname?.toLowerCase().includes(searchName) || c.remark?.toLowerCase().includes(searchName)
  )

  if (!contact) {
    return { success: false, error: `未找到联系人"${args.contactName}"` }
  }

  let startTime = 0
  const now = new Date()
  switch (args.timeRange) {
    case 'today': startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000; break
    case 'this_week': startTime = new Date(now.getTime() - 7 * 86400000).getTime() / 1000; break
    case 'this_month': startTime = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000; break
    case 'this_year': startTime = new Date(now.getFullYear(), 0, 1).getTime() / 1000; break
  }

  const messagesResult = await chatServiceCore.getMessages(contact.username, 0, args.limit || 100, startTime, Date.now() / 1000)
  const messages = messagesResult?.messages || []

  if (!messages || messages.length === 0) {
    return { success: false, error: `该时间段内没有与"${contact.remark || contact.nickname || contact.username}"的聊天记录` }
  }

  const textMessages = messages.filter((m: any) =>
    m.content && typeof m.content === 'string' && m.content.length > 5
  )

  return {
    success: true,
    data: {
      contactName: contact.remark || contact.nickname || contact.username,
      totalScanned: messages.length,
      textMessages: textMessages.slice(0, 50).map((m: any) => ({
        content: m.content.slice(0, 300),
        time: m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : '',
        sender: m.isSend ? '我' : '对方'
      }))
    }
  }
}

async function executeListAllContacts(args: any) {
  const result = await chatServiceCore.getContacts({ lite: true })

  if (!result?.success) {
    return { success: false, error: result?.error || '获取联系人列表失败' }
  }

  const contacts = result.contacts || []

  if (contacts.length === 0) {
    return { success: false, error: '联系人列表为空' }
  }

  const limit = args.limit || 50

  return {
    success: true,
    data: {
      totalContacts: contacts.length,
      contacts: contacts.slice(0, limit).map((c: any) => ({
        nickname: c.nickname || '',
        remark: c.remark || '',
        username: c.username || ''
      }))
    }
  }
}

async function executeListAllGroups(args: any) {
  const result = await chatServiceCore.getGroupChats()

  if (!result?.success) {
    return { success: false, error: result?.error || '获取群聊列表失败' }
  }

  const groups = result.data || []

  if (groups.length === 0) {
    return { success: false, error: '群聊列表为空' }
  }

  const limit = args.limit || 50

  return {
    success: true,
    data: {
      totalGroups: groups.length,
      groups: groups.slice(0, limit).map((g: any) => ({
        displayName: g.displayName || '',
        username: g.username || '',
        memberCount: g.memberCount || 0
      }))
    }
  }
}

run().catch((error) => {
  parentPort?.postMessage({
    type: 'tool:error',
    error: String(error)
  })
})

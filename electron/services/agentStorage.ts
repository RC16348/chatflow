/**
 * Agent 对话存储服务（主进程端）
 * 使用 JSON 文件存储在 userData/agent_data/ 目录下
 * 每个会话一个 JSON 文件，避免单文件过大
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs'

const AGENT_DATA_DIR = 'agent_data'
const CONVERSATIONS_INDEX_FILE = 'conversations_index.json'

interface ConversationRecord {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessage?: string
}

interface AgentMessageRecord {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: any[]
  toolResults?: any[]
  renderType?: string
  renderData?: any
  createdAt: number
}

function getDataDir(): string {
  const dir = join(app.getPath('userData'), AGENT_DATA_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function getConversationFilePath(convId: string): string {
  return join(getDataDir(), `${convId}.json`)
}

function getIndexFilePath(): string {
  return join(getDataDir(), CONVERSATIONS_INDEX_FILE)
}

// ─── 会话索引管理 ─────────────────────────────────────

function readIndex(): ConversationRecord[] {
  try {
    const path = getIndexFilePath()
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch (e) {
    console.error('[AgentStorage] 读取索引失败:', e)
  }
  return []
}

function writeIndex(index: ConversationRecord[]): void {
  try {
    writeFileSync(getIndexFilePath(), JSON.stringify(index), 'utf-8')
  } catch (e) {
    console.error('[AgentStorage] 写入索引失败:', e)
  }
}

// ─── 会话文件管理 ─────────────────────────────────────

function readConversationFile(convId: string): { conversation: ConversationRecord; messages: AgentMessageRecord[] } | null {
  try {
    const path = getConversationFilePath(convId)
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch (e) {
    console.error(`[AgentStorage] 读取会话文件失败 (${convId}):`, e)
  }
  return null
}

function writeConversationFile(data: { conversation: ConversationRecord; messages: AgentMessageRecord[] }): void {
  try {
    writeFileSync(getConversationFilePath(data.conversation.id), JSON.stringify(data), 'utf-8')
  } catch (e) {
    console.error(`[AgentStorage] 写入会话文件失败:`, e)
  }
}

// ─── 导出的 IPC 处理函数 ───────────────────────────────

export function agentListConversations(): ConversationRecord[] {
  const index = readIndex()
  return index.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function agentGetConversation(convId: string): { conversation: ConversationRecord; messages: AgentMessageRecord[] } | null {
  return readConversationFile(convId)
}

export function agentCreateConversation(convId: string, title: string): ConversationRecord {
  const now = Date.now()
  const record: ConversationRecord = {
    id: convId,
    title: title || '新对话',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  }

  // 写入会话文件
  writeConversationFile({ conversation: record, messages: [] })

  // 更新索引
  const index = readIndex()
  index.unshift(record)
  writeIndex(index)

  return record
}

export function agentSaveMessage(convId: string, message: AgentMessageRecord): void {
  let data = readConversationFile(convId)
  
  // 如果会话不存在，自动创建会话
  if (!data) {
    const now = Date.now()
    const record: ConversationRecord = {
      id: convId,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    data = { conversation: record, messages: [] }
    
    // 更新索引
    const index = readIndex()
    if (!index.find(c => c.id === convId)) {
      index.unshift(record)
      writeIndex(index)
    }
  }

  message.conversationId = convId
  data.messages.push(message)

  // 更新会话元数据
  data.conversation.updatedAt = Date.now()
  data.conversation.messageCount = data.messages.length
  data.conversation.lastMessage = message.content?.slice(0, 100)

  // 如果是第一条用户消息，更新标题
  if (message.role === 'user' && data.messages.filter(m => m.role === 'user').length === 1) {
    data.conversation.title = message.content.slice(0, 50).replace(/\n/g, ' ')
  }

  writeConversationFile(data)

  // 同步更新索引
  const index = readIndex()
  const idx = index.findIndex(c => c.id === convId)
  if (idx >= 0) {
    index[idx] = data.conversation
  } else {
    index.unshift(data.conversation)
  }
  writeIndex(index)
}

export function agentDeleteConversation(convId: string): boolean {
  try {
    // 删除会话文件
    const filePath = getConversationFilePath(convId)
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }

    // 从索引中移除
    const index = readIndex()
    const filtered = index.filter(c => c.id !== convId)
    writeIndex(filtered)

    return true
  } catch (e) {
    console.error(`[AgentStorage] 删除会话失败 (${convId}):`, e)
    return false
  }
}

export function agentClearAllData(): boolean {
  try {
    const dir = getDataDir()
    const files = readdirSync(dir)
    for (const file of files) {
      const filePath = join(dir, file)
      if (statSync(filePath).isFile()) {
        unlinkSync(filePath)
      }
    }
    return true
  } catch (e) {
    console.error('[AgentStorage] 清除所有数据失败:', e)
    return false
  }
}

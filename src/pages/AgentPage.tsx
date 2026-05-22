import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Plus, Send, Trash2, MessageSquare, Bot, User,
  PanelLeftClose, PanelLeft, Wrench, CheckCircle,
  Loader2, ChevronRight, Sparkles, Search,
  Users, BarChart3, PenLine, Copy, Check, RotateCcw,
  AlertTriangle, X
} from 'lucide-react'
import { agentEngine } from '../services/agent/agentEngine'
import { agentStorage } from '../services/agent/agentStorage'
import { agentState, type AgentSessionState, type MessageItem, type ConversationItem, type ToolCall, type AgentTask } from '../services/agent/agentState'
import { backgroundTaskExecutor, type AsyncTask } from '../services/agent/backgroundTaskExecutor'
import type { Conversation, AgentMessage } from '../types/agent'
import './AgentPage.scss'

// ==================== 类型定义 ====================

// ==================== Markdown 简易渲染 ====================

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++
      elements.push(
        <div key={key++} className="agent-md-code-block">
          {lang && <div className="agent-md-code-lang">{lang}</div>}
          <pre><code>{codeLines.join('\n')}</code></pre>
        </div>
      )
      continue
    }

    if (line.trimStart().startsWith('|') && line.includes('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|') && lines[i].includes('|')) {
        tableLines.push(lines[i])
        i++
      }
      elements.push(renderTable(tableLines, key))
      key += 10
      continue
    }

    if (/^(\s{0,3})(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      elements.push(<hr key={key++} className="agent-md-hr" />)
      i++
      continue
    }

    if (line.match(/^>\s/)) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      elements.push(
        <blockquote key={key++} className="agent-md-blockquote">
          {renderMarkdown(quoteLines.join('\n'))}
        </blockquote>
      )
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const content = inlineFormat(headingMatch[2])
      const Tag = `h${Math.min(level, 6)}` as React.ElementType
      elements.push(
        <Tag key={key++} className={`agent-md-h${level}`}>
          {content}
        </Tag>
      )
      i++
      continue
    }

    if (line.match(/^[\s]*[-*+]\s+/)) {
      const listItems: React.ReactNode[] = []
      while (i < lines.length && lines[i].match(/^[\s]*[-*+]\s+/)) {
        const itemText = lines[i].replace(/^[\s]*[-*+]\s+/, '')
        listItems.push(
          <li key={key++}>{inlineFormat(itemText)}</li>
        )
        i++
      }
      elements.push(
        <ul key={key++} className="agent-md-list">{listItems}</ul>
      )
      continue
    }

    if (line.match(/^[\s]*\d+\.\s+/)) {
      const listItems: React.ReactNode[] = []
      while (i < lines.length && lines[i].match(/^[\s]*\d+\.\s+/)) {
        const itemText = lines[i].replace(/^[\s]*\d+\.\s+/, '')
        listItems.push(
          <li key={key++}>{inlineFormat(itemText)}</li>
        )
        i++
      }
      elements.push(
        <ol key={key++} className="agent-md-list">{listItems}</ol>
      )
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    elements.push(
      <p key={key++} className="agent-md-p">{inlineFormat(line)}</p>
    )
    i++
  }

  return elements
}

function renderTable(tableLines: string[], startKey: number): React.ReactNode {
  const parseRow = (line: string): string[] => {
    return line.split('|').map(cell => cell.trim()).filter(cell => cell !== '')
  }

  const headerLine = tableLines[0]
  const headers = parseRow(headerLine)

  let alignments: ('left' | 'center' | 'right')[] = []

  if (tableLines.length > 1 && /^[\s|:-]+$/.test(tableLines[1].trim())) {
    const alignLine = parseRow(tableLines[1])
    alignments = alignLine.map(cell => {
      const trimmed = cell.trim()
      if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
      if (trimmed.startsWith(':')) return 'left'
      if (trimmed.endsWith(':')) return 'right'
      return 'left'
    })
  } else {
    alignments = headers.map(() => 'left')
  }

  const dataRows = alignments.length > 0 && /^[\s|:-]+$/.test(tableLines[1]?.trim() || '')
    ? tableLines.slice(2)
    : tableLines.slice(1)

  let key = startKey

  return (
    <div key={startKey} className="agent-md-table-wrapper">
      <table className="agent-md-table">
        <thead>
          <tr>
            {headers.map((header, idx) => (
              <th
                key={key++}
                className={`agent-md-th agent-md-align-${alignments[idx] || 'left'}`}
              >
                {inlineFormat(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, rowIdx) => {
            const cells = parseRow(row)
            return (
              <tr key={rowIdx}>
                {cells.map((cell, cellIdx) => (
                  <td
                    key={key++}
                    className={`agent-md-td agent-md-align-${alignments[cellIdx] || 'left'}`}
                  >
                    {inlineFormat(cell)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function inlineFormat(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let key = 0

  const patterns = [
    { regex: /\*\*(.+?)\*\*/g, tag: 'strong', className: 'agent-md-bold' },
    { regex: /~~(.+?)~~/g, tag: 'del', className: 'agent-md-strikethrough' },
    { regex: /`([^`]+)`/g, tag: 'code', className: 'agent-md-inline-code' }
  ]

  let lastIndex = 0
  const matches: Array<{ index: number; length: number; content: string; tag: string; className: string }> = []

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    pattern.regex.lastIndex = 0
    while ((match = pattern.regex.exec(text)) !== null) {
      matches.push({
        index: match.index,
        length: match[0].length,
        content: match[1],
        tag: pattern.tag,
        className: pattern.className
      })
    }
  }

  matches.sort((a, b) => a.index - b.index)

  for (const match of matches) {
    if (match.index < lastIndex) continue

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }

    const Tag = match.tag as React.ElementType
    parts.push(
      <Tag key={key++} className={match.className}>{match.content}</Tag>
    )
    lastIndex = match.index + match.length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

// ==================== 工具调用卡片 ====================

function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const statusIcon = toolCall.status === 'running'
    ? <Loader2 size={14} className="agent-tool-status-icon spinning" />
    : toolCall.status === 'success'
      ? <CheckCircle size={14} className="agent-tool-status-icon success" />
      : <span className="agent-tool-status-icon error">!</span>

  const statusText = toolCall.status === 'running'
    ? '执行中...'
    : toolCall.status === 'success'
      ? '完成'
      : '失败'

  return (
    <div className={`agent-tool-card ${toolCall.status}`}>
      <div className="agent-tool-card-header">
        <Wrench size={14} className="agent-tool-icon" />
        <span className="agent-tool-name">{toolCall.name}</span>
        {statusIcon}
        <span className="agent-tool-status">{statusText}</span>
      </div>
      {Object.keys(toolCall.params).length > 0 && (
        <div className="agent-tool-params">
          {Object.entries(toolCall.params).map(([k, v]) => (
            <div key={k} className="agent-tool-param">
              <span className="agent-tool-param-key">{k}:</span>
              <span className="agent-tool-param-value">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
      {toolCall.result && (
        <div className="agent-tool-result">{toolCall.result}</div>
      )}
    </div>
  )
}

// ==================== 空状态组件 ====================

function EmptyState({ onQuickAction }: { onQuickAction: (msg: string) => void }) {
  const quickActions = [
    { icon: <BarChart3 size={18} />, label: '总结最近的聊天', message: '帮我总结一下最近一周的聊天记录，请问我应该分析哪个联系人？' },
    { icon: <Search size={18} />, label: '搜索历史消息', message: '帮我搜索包含特定关键词的聊天记录，请告诉我关键词和联系人（可选）' },
    { icon: <Users size={18} />, label: '分析群聊角色', message: '帮我分析一下群聊中各成员的活跃度和角色，请告诉我你想分析哪个群聊' },
    { icon: <PenLine size={18} />, label: '我的聊天风格', message: '分析一下我的整体聊天风格和习惯（基于所有联系人的全局分析）' },
  ]

  return (
    <div className="agent-empty-state">
      <div className="agent-empty-icon">
        <Bot size={48} />
      </div>
      <h2 className="agent-empty-title">ChatFlow AI 助手</h2>
      <p className="agent-empty-desc">
        我可以帮你分析聊天记录、搜索历史消息、总结对话内容等。
        选择下方的快捷操作，或直接输入你的问题。
      </p>
      <div className="agent-quick-actions">
        {quickActions.map((action) => (
          <button
            key={action.label}
            className="agent-quick-action-btn"
            onClick={() => onQuickAction(action.message)}
          >
            <span className="agent-quick-action-icon">{action.icon}</span>
            <span className="agent-quick-action-label">{action.label}</span>
            <ChevronRight size={14} className="agent-quick-action-arrow" />
          </button>
        ))}
      </div>
    </div>
  )
}

// ==================== 未完成任务提示组件 ====================

function UnfinishedTaskBanner({
  task,
  onResume,
  onCancel,
  onDismiss
}: {
  task: AgentTask
  onResume: () => void
  onCancel: () => void
  onDismiss: () => void
}) {
  const [isVisible, setIsVisible] = useState(true)
  const [isAutoDismissing, setIsAutoDismissing] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsAutoDismissing(true)
      setTimeout(() => {
        setIsVisible(false)
        onDismiss()
      }, 500)
    }, 8000)

    return () => clearTimeout(timer)
  }, [onDismiss])

  if (!isVisible) return null

  return (
    <div className={`agent-unfinished-task-banner ${isAutoDismissing ? 'fade-out' : ''}`}>
      <AlertTriangle size={16} className="agent-banner-icon" />
      <div className="agent-banner-content">
        <span className="agent-banner-title">检测到未完成的任务</span>
        <span className="agent-banner-desc">
          上次对话："{task.userMessage.slice(0, 50)}{task.userMessage.length > 50 ? '...' : ''}"
        </span>
      </div>
      <div className="agent-banner-actions">
        <button className="agent-banner-resume-btn" onClick={onResume}>
          查看结果
        </button>
        <button className="agent-banner-cancel-btn" onClick={onCancel}>
          忽略
        </button>
      </div>
      <button className="agent-banner-close-btn" onClick={() => {
        setIsAutoDismissing(true)
        setTimeout(() => {
          setIsVisible(false)
          onCancel()
        }, 500)
      }}>
        <X size={14} />
      </button>
    </div>
  )
}

// ==================== 状态完整性警告组件 ====================

function IntegrityWarningBanner({
  reason,
  onUseCache,
  onReload
}: {
  reason: string
  onUseCache: () => void
  onReload: () => void
}) {
  const [isVisible, setIsVisible] = useState(true)

  if (!isVisible) return null

  return (
    <div className="agent-integrity-warning-banner">
      <AlertTriangle size={16} className="agent-warning-icon" />
      <div className="agent-warning-content">
        <span className="agent-warning-title">数据一致性警告</span>
        <span className="agent-warning-desc">{reason}</span>
      </div>
      <div className="agent-warning-actions">
        <button className="agent-warning-use-cache-btn" onClick={() => {
          setIsVisible(false)
          onUseCache()
        }}>
          使用缓存数据
        </button>
        <button className="agent-warning-reload-btn" onClick={() => {
          setIsVisible(false)
          onReload()
        }}>
          重新加载
        </button>
      </div>
    </div>
  )
}

// ==================== 任务队列状态组件 ====================

function TaskQueueStatus({ 
  queueLength, 
  currentExecutingTaskId,
  onCancelTask 
}: { 
  queueLength: number
  currentExecutingTaskId: string | null
  onCancelTask: (taskId: string) => void
}) {
  if (queueLength === 0) return null

  const pendingCount = Math.max(0, queueLength - (currentExecutingTaskId ? 1 : 0))

  return (
    <div className="agent-task-queue-status">
      <div className="agent-queue-info">
        <Loader2 size={14} className="spinning" />
        <span className="agent-queue-text">
          {currentExecutingTaskId ? '执行中...' : ''}
          {pendingCount > 0 && (
            <span className="agent-pending-count">
              ，{pendingCount} 个任务排队中
            </span>
          )}
        </span>
      </div>
      {currentExecutingTaskId && (
        <button 
          className="agent-cancel-task-btn"
          onClick={() => onCancelTask(currentExecutingTaskId)}
          title="取消当前任务"
        >
          <X size={12} />
          取消
        </button>
      )}
    </div>
  )
}

// ==================== 主组件 ====================

const MAX_VISIBLE_MESSAGES = 200

export default function AgentPage() {
  // 全局状态（从 agentState 获取）
  const [globalState, setGlobalState] = useState<AgentSessionState>(() => agentState.getState())
  
  // 本地 UI 状态（不需要持久化）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)
  const [showUnfinishedTask, setShowUnfinishedTask] = useState<AgentTask | null>(null)
  const [showIntegrityWarning, setShowIntegrityWarning] = useState<string | null>(null)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const isProcessingRef = useRef(false)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // 订阅全局状态变更
  useEffect(() => {
    unsubscribeRef.current = agentState.subscribe((newState) => {
      setGlobalState(newState)
    })

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
      }
    }
  }, [])

  // 组件挂载时：恢复状态并检查未完成任务
  useEffect(() => {
    const initialize = async () => {
      try {
        console.log('[AgentPage] 组件开始初始化...')
        agentState.setComponentMounted(true)

        const restored = await agentState.restoreState()

        if (restored) {
          console.log('[AgentPage] 状态恢复成功')

          if (agentState.hasIntegrityWarning()) {
            console.warn('[AgentPage] 检测到数据完整性问题:', agentState.getIntegrityWarningReason())
            setShowIntegrityWarning(agentState.getIntegrityWarningReason())
          }

          const activeTasks = agentState.getActiveTasks()
          if (activeTasks.length > 0) {
            console.log(`[AgentPage] 发现 ${activeTasks.length} 个未完成任务`)
            const latestTask = activeTasks[activeTasks.length - 1]
            setShowUnfinishedTask(latestTask)
          }

          backgroundTaskExecutor.resubscribeProgressCallbacks()

          setGlobalState(agentState.getState())
        } else {
          console.log('[AgentPage] 无可恢复的状态，加载初始数据')
          await agentState.loadConversationsFromStorage()
          setGlobalState(agentState.getState())
        }
      } catch (e) {
        console.error('[AgentPage] 初始化失败:', e)
        try {
          await agentState.loadConversationsFromStorage()
          setGlobalState(agentState.getState())
        } catch (fallbackError) {
          console.error('[AgentPage] 回退初始化也失败:', fallbackError)
        }
      }
    }

    initialize()

    return () => {
      console.log('[AgentPage] 组件即将卸载，执行清理操作...')

      agentState.persistStateImmediate().catch(e => {
        console.error('[AgentPage] 卸载前保存状态失败:', e)
      })

      agentState.setComponentMounted(false)

      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }

      console.log('[AgentPage] 组件卸载完成')
    }
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    if (scrollContainerRef.current) {
      const el = scrollContainerRef.current
      el.scrollTop = el.scrollHeight
    }
  }, [globalState.messages])

  // 从全局状态解构常用值
  const { conversations, currentConvId, messages, inputValue, isLoading, queueLength, currentExecutingTaskId } = globalState

  const handleNewConversation = useCallback(() => {
    const newId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const newConv: ConversationItem = {
      id: newId,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    }
    
    agentState.setState({
      conversations: [newConv, ...conversations],
      currentConvId: newId,
      messages: [],
      inputValue: '',
    })

    agentStorage.createConversation(newId, '新对话').catch(e => {
      console.error('创建会话失败:', e)
    })

    inputRef.current?.focus()
  }, [conversations])

  const handleSelectConversation = useCallback(async (convId: string) => {
    if (convId === currentConvId) return

    // 先清空消息，避免显示旧会话内容
    agentState.setState({ messages: [], currentConvId: convId })

    // 然后加载新会话的消息
    await agentState.loadMessagesForConversation(convId)
  }, [currentConvId])

  const handleDeleteConversation = useCallback(async (convId: string) => {
    try {
      await agentStorage.deleteConversation(convId)
      
      const newConversations = conversations.filter(c => c.id !== convId)
      const newState: Partial<AgentSessionState> = { conversations: newConversations }
      
      if (currentConvId === convId) {
        newState.currentConvId = null
        newState.messages = []
      }
      
      agentState.setState(newState)
    } catch (e) {
      console.error('删除会话失败:', e)
    }
    setShowDeleteConfirm(null)
  }, [currentConvId, conversations])

  const generateTitle = useCallback((firstMessage: string): string => {
    const cleaned = firstMessage.replace(/\n/g, ' ').trim()
    return cleaned.length > 20 ? cleaned.slice(0, 20) + '...' : cleaned
  }, [])

  const updateConversationTitle = useCallback((convId: string, title: string) => {
    const updatedConversations = conversations.map(c =>
      c.id === convId ? { ...c, title, updatedAt: Date.now() } : c
    )
    agentState.setState({ conversations: updatedConversations })
  }, [conversations])

  const appendMessage = useCallback((msg: MessageItem) => {
    const currentMessages = agentState.getState().messages
    const next = [...currentMessages, msg]
    
    if (next.length > MAX_VISIBLE_MESSAGES) {
      next.splice(0, next.length - MAX_VISIBLE_MESSAGES)
    }
    
    agentState.setState({ messages: next })
  }, [])

  const updateLastAssistantMessage = useCallback((content: string, toolCalls?: ToolCall[]) => {
    const currentMessages = agentState.getState().messages
    const next = [...currentMessages]
    
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].role === 'assistant') {
        next[i] = { ...next[i], content, toolCalls, isStreaming: false }
        break
      }
    }
    
    agentState.setState({ messages: next })
  }, [])

  const handleSend = useCallback(async (text?: string) => {
    const content = (text || inputValue).trim()
    if (!content || isLoading || isProcessingRef.current) return

    isProcessingRef.current = true
    setShowUnfinishedTask(null)

    let convId = currentConvId
    if (!convId) {
      convId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newConv: ConversationItem = {
        id: convId,
        title: generateTitle(content),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
      }

      const currentState = agentState.getState()
      agentState.setState({
        conversations: [newConv, ...currentState.conversations],
        currentConvId: convId,
        messages: [],
      })

      agentStorage.createConversation(convId, generateTitle(content)).catch(e => {
        console.error('创建会话失败:', e)
      })
    } else {
      const conv = conversations.find(c => c.id === convId)
      if (conv && conv.messageCount === 0) {
        updateConversationTitle(convId, generateTitle(content))
      }
    }

    agentState.setState({ inputValue: '' })

    const task = agentState.createTask(convId, content)

    const userMsg: MessageItem = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    appendMessage(userMsg)

    const aiMsgId = `msg-${Date.now()}-assistant`
    const aiMsg: MessageItem = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    }
    appendMessage(aiMsg)

    const executeTask = async (signal?: AbortSignal): Promise<any> => {
      console.log('[Agent] 正在从授权服务获取API配置...')
      const apiConfig = await window.electronAPI.licenseAuth.fetchApiKey()

      if (!apiConfig.authorized || !apiConfig.has_key) {
        throw new Error('未获得授权或API Key未配置，请检查授权状态')
      }

      if (!apiConfig.api_key || !apiConfig.api_url) {
        throw new Error('API配置不完整，请检查授权平台设置')
      }

      console.log('[Agent] 更新Agent引擎配置:', {
        apiUrl: apiConfig.api_url,
        model: apiConfig.model,
        apiKey: apiConfig.api_key ? '已设置' : '未设置'
      })

      agentEngine.updateConfig({
        apiKey: apiConfig.api_key,
        apiUrl: apiConfig.api_url,
        model: apiConfig.model || 'gpt-4o'
      })

      const currentMessages = agentState.getState().messages
      const history: any[] = currentMessages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
        .slice(0, -1)
        .map(m => ({
          role: m.role,
          content: m.content,
        }))

      const response = await agentEngine.processMessage(
        content,
        history,
        (toolName: string, args: any) => {
          const toolCall: ToolCall = {
            id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: toolName,
            params: args,
            status: 'running',
          }

          const currentMsgs = agentState.getState().messages
          const next = [...currentMsgs]
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === 'assistant') {
              const existing = next[i].toolCalls || []
              next[i] = { ...next[i], toolCalls: [...existing, toolCall] }
              break
            }
          }
          agentState.setState({ messages: next })

          agentState.updateTask(task.id, {
            partialResponse: `工具调用: ${toolName}`
          })
        },
        (toolName: string, current: number, total: number, message?: string) => {
          // 工具执行进度回调
          const currentMsgs = agentState.getState().messages
          const next = [...currentMsgs]
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === 'assistant' && next[i].toolCalls) {
              const toolCalls = [...next[i].toolCalls!]
              // 找到正在执行的工具调用并更新进度
              for (let j = toolCalls.length - 1; j >= 0; j--) {
                if (toolCalls[j].name === toolName && toolCalls[j].status === 'running') {
                  toolCalls[j] = {
                    ...toolCalls[j],
                    progress: { current, total, message }
                  }
                  next[i] = { ...next[i], toolCalls }
                  break
                }
              }
              break
            }
          }
          agentState.setState({ messages: next })

          agentState.updateTask(task.id, {
            partialResponse: `正在执行 ${toolName}: ${current}/${total}${message ? ` - ${message}` : ''}`
          })
        },
        (token: string) => {
          const currentMsgs = agentState.getState().messages
          const next = [...currentMsgs]
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === 'assistant') {
              next[i] = { ...next[i], content: next[i].content + token }
              break
            }
          }
          agentState.setState({ messages: next })

          agentState.updateTask(task.id, {
            partialResponse: next[next.length - 1]?.content || ''
          })
        },
        {
          background: true,
          signal, // 传递 signal 以支持取消
          onProgress: (token: string) => {
            // 实时更新 partialResponse
          },
          onComplete: (result: any) => {
            console.log('[AgentPage] 后台任务完成:', task.id)
          },
          onError: (error: Error) => {
            console.error('[AgentPage] 后台任务错误:', task.id, error)
          }
        }
      )

      if (response) {
        updateLastAssistantMessage(response.content || '')
      }

      if (convId) {
        await agentStorage.saveMessage(convId, {
          id: `msg-${Date.now()}-user`,
          conversationId: convId,
          role: 'user',
          content,
          createdAt: Date.now(),
        })
        if (response) {
          await agentStorage.saveMessage(convId, {
            id: response.id,
            conversationId: convId,
            role: 'assistant',
            content: response.content,
            createdAt: response.createdAt,
          })
        }
      }

      const currentConvs = agentState.getState().conversations
      const updatedConvs = currentConvs.map(c =>
        c.id === convId ? { ...c, messageCount: c.messageCount + 2, updatedAt: Date.now() } : c
      )
      agentState.setState({ conversations: updatedConvs })

      return response
    }

    backgroundTaskExecutor.submit(task, executeTask)

    const unsubscribe = backgroundTaskExecutor.subscribe((updatedTask: AsyncTask) => {
      if (updatedTask.id === task.id) {
        if (updatedTask.status === 'completed' || updatedTask.status === 'failed' || updatedTask.status === 'cancelled') {
          agentState.setState({ isLoading: false })
          isProcessingRef.current = false
          inputRef.current?.focus()
          unsubscribe()
        }

        const status = backgroundTaskExecutor.getStatus()
        agentState.updateQueueInfo(status.queueLength, status.currentTaskId)
      }
    })

    const queueStatus = backgroundTaskExecutor.getStatus()
    agentState.updateQueueInfo(queueStatus.queueLength, queueStatus.currentTaskId)
  }, [inputValue, isLoading, currentConvId, conversations, generateTitle, updateConversationTitle, appendMessage, updateLastAssistantMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleQuickAction = useCallback((message: string) => {
    handleSend(message)
  }, [handleSend])

  // 复制消息内容
  const handleCopyMessage = useCallback(async (content: string, msgId: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedMsgId(msgId)
      setTimeout(() => setCopiedMsgId(null), 2000)
    } catch (e) {
      console.error('复制失败:', e)
    }
  }, [])

  // 回退消息
  const handleRollbackMessage = useCallback(async (msgId: string) => {
    const msgIndex = messages.findIndex(m => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = messages[msgIndex]
    if (targetMsg.role !== 'user') return

    agentState.setState({ inputValue: targetMsg.content })

    const newMessages = messages.slice(0, msgIndex)
    agentState.setState({ messages: newMessages })

    if (currentConvId) {
      try {
        const convData = await agentStorage.getConversation(currentConvId)
        if (convData) {
          await agentStorage.deleteConversation(currentConvId)
          await agentStorage.createConversation(currentConvId, convData.conversation.title)
          for (const msg of newMessages) {
            await agentStorage.saveMessage(currentConvId, {
              id: msg.id,
              conversationId: currentConvId,
              role: msg.role,
              content: msg.content,
              createdAt: msg.timestamp,
            })
          }
        }
        
        const currentConvs = agentState.getState().conversations
        const updatedConvs = currentConvs.map(c =>
          c.id === currentConvId ? { ...c, messageCount: newMessages.length, updatedAt: Date.now() } : c
        )
        agentState.setState({ conversations: updatedConvs })
      } catch (e) {
        console.error('回退消息失败:', e)
      }
    }

    inputRef.current?.focus()
  }, [messages, currentConvId])

  // 继续未完成任务
  const handleResumeTask = useCallback(async () => {
    if (!showUnfinishedTask) return
    
    const task = showUnfinishedTask
    setShowUnfinishedTask(null)
    
    // 切换到该任务的会话
    if (task.convId !== currentConvId) {
      agentState.setState({ currentConvId: task.convId })
      await agentState.loadMessagesForConversation(task.convId)
    }
    
    // 如果有部分响应，显示给用户
    if (task.partialResponse) {
      console.log('[AgentPage] 恢复任务的部分响应')
    }
    
    // 重新发送消息
    handleSend(task.userMessage)
  }, [showUnfinishedTask, currentConvId, handleSend])

  // 取消未完成任务
  const handleCancelTask = useCallback(() => {
    if (!showUnfinishedTask) return

    agentState.cancelTask(showUnfinishedTask.id)
    setShowUnfinishedTask(null)
    agentState.setState({
      isLoading: false,
      activeTaskId: null,
    }, true)
  }, [showUnfinishedTask])

  // 处理完整性警告 - 使用缓存数据
  const handleUseCachedData = useCallback(() => {
    console.log('[AgentPage] 用户选择使用缓存数据')
    setShowIntegrityWarning(null)
  }, [])

  // 处理完整性警告 - 重新加载
  const handleReloadData = useCallback(async () => {
    console.log('[AgentPage] 用户选择重新加载数据')
    setShowIntegrityWarning(null)

    try {
      agentState.resetState()
      await agentState.loadConversationsFromStorage()
      setGlobalState(agentState.getState())
    } catch (e) {
      console.error('[AgentPage] 重新加载失败:', e)
    }
  }, [])

  // 取消队列中的任务
  const handleCancelQueueTask = useCallback((taskId: string) => {
    const success = backgroundTaskExecutor.cancel(taskId)

    const status = backgroundTaskExecutor.getStatus()
    agentState.updateQueueInfo(status.queueLength, status.currentTaskId)
    agentState.setState({ isLoading: status.isProcessing })

    console.log('[AgentPage] 取消操作结果:', success ? '成功' : '失败(任务可能已完成)')
  }, [])

  // 渲染消息列表（限制数量）
  const visibleMessages = useMemo(() => {
    if (messages.length <= MAX_VISIBLE_MESSAGES) return messages
    return messages.slice(messages.length - MAX_VISIBLE_MESSAGES)
  }, [messages])

  const hasMessages = visibleMessages.length > 0

  return (
    <div className="agent-page">
      {/* 顶部标题栏 */}
      <div className="agent-header">
        <div className="agent-header-left">
          <button
            className="agent-sidebar-toggle"
            onClick={() => setSidebarCollapsed(prev => !prev)}
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          >
            {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <div className="agent-header-title">
            <Bot size={20} />
            <span>AI 助手</span>
          </div>
        </div>
        <button className="agent-new-conv-btn" onClick={handleNewConversation}>
          <Plus size={16} />
          <span>新对话</span>
        </button>
      </div>

      {/* 未完成任务提示 */}
      {showUnfinishedTask && (
        <UnfinishedTaskBanner
          task={showUnfinishedTask}
          onResume={handleResumeTask}
          onCancel={handleCancelTask}
          onDismiss={() => setShowUnfinishedTask(null)}
        />
      )}

      {/* 数据完整性警告 */}
      {showIntegrityWarning && (
        <IntegrityWarningBanner
          reason={showIntegrityWarning}
          onUseCache={handleUseCachedData}
          onReload={handleReloadData}
        />
      )}

      {/* 任务队列状态 */}
      <TaskQueueStatus
        queueLength={queueLength}
        currentExecutingTaskId={currentExecutingTaskId}
        onCancelTask={handleCancelQueueTask}
      />

      {/* 主体区域 */}
      <div className="agent-body">
        {/* 左侧会话列表 */}
        <div className={`agent-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          <div className="agent-sidebar-header">
            <span className="agent-sidebar-title">历史会话</span>
            <span className="agent-sidebar-count">{conversations.length}</span>
          </div>
          <div className="agent-sidebar-list">
            {conversations.length === 0 ? (
              <div className="agent-sidebar-empty">
                <MessageSquare size={24} />
                <span>暂无会话记录</span>
              </div>
            ) : (
              conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`agent-sidebar-item ${conv.id === currentConvId ? 'active' : ''}`}
                  onClick={() => handleSelectConversation(conv.id)}
                >
                  <div className="agent-sidebar-item-content">
                    <MessageSquare size={14} className="agent-sidebar-item-icon" />
                    <span className="agent-sidebar-item-title">{conv.title}</span>
                  </div>
                  <button
                    className="agent-sidebar-item-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowDeleteConfirm(conv.id)
                    }}
                    title="删除会话"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右侧对话区域 */}
        <div className="agent-chat-area">
          {/* 消息列表 */}
          <div className="agent-messages" ref={scrollContainerRef}>
            {!hasMessages ? (
              <EmptyState onQuickAction={handleQuickAction} />
            ) : (
              <div className="agent-messages-list">
                {visibleMessages.map(msg => (
                  <div key={msg.id} className={`agent-message agent-message-${msg.role}`}>
                    <div className="agent-message-avatar">
                      {msg.role === 'assistant'
                        ? <div className="agent-avatar-ai"><Bot size={18} /></div>
                        : <div className="agent-avatar-user"><User size={18} /></div>
                      }
                    </div>
                    <div className="agent-message-body">
                      {/* 工具调用卡片 */}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="agent-message-tools">
                          {msg.toolCalls.map(tc => (
                            <ToolCallCard key={tc.id} toolCall={tc} />
                          ))}
                        </div>
                      )}
                      {/* 消息内容 */}
                      {msg.content && (
                        <div className={`agent-message-bubble agent-bubble-${msg.role}`}>
                          {msg.role === 'assistant'
                            ? <div className="agent-md-content">{renderMarkdown(msg.content)}</div>
                            : <div className="agent-user-text">{msg.content}</div>
                          }
                          {msg.isStreaming && (
                            <span className="agent-streaming-cursor">|</span>
                          )}
                          {/* 复制按钮 - hover显示 */}
                          <button
                            className="agent-message-copy-btn"
                            onClick={() => handleCopyMessage(msg.content, msg.id)}
                            title="复制内容"
                            disabled={msg.isStreaming}
                          >
                            {copiedMsgId === msg.id ? (
                              <Check size={14} className="agent-copy-icon copied" />
                            ) : (
                              <Copy size={14} className="agent-copy-icon" />
                            )}
                          </button>
                        </div>
                      )}
                      {/* 仅加载中且无内容时显示 loading */}
                      {msg.isStreaming && !msg.content && (
                        <div className="agent-message-loading">
                          <Loader2 size={16} className="spinning" />
                          <span>思考中...</span>
                        </div>
                      )}
                      {/* 回退按钮 - 仅用户消息显示 */}
                      {msg.role === 'user' && !msg.isStreaming && (
                        <button
                          className="agent-message-rollback-btn"
                          onClick={() => handleRollbackMessage(msg.id)}
                          title="回退到发送前"
                        >
                          <RotateCcw size={14} className="agent-rollback-icon" />
                          <span>回退</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 输入区域 */}
          <div className="agent-input-area">
            <div className="agent-input-container">
              <textarea
                ref={inputRef}
                className="agent-input"
                value={inputValue}
                onChange={e => agentState.setState({ inputValue: e.target.value })}
                onKeyDown={handleKeyDown}
                placeholder="输入你的问题... (Enter 发送, Shift+Enter 换行)"
                rows={1}
                disabled={isLoading}
              />
              <button
                className={`agent-send-btn ${isLoading || !inputValue.trim() ? 'disabled' : ''}`}
                onClick={() => handleSend()}
                disabled={isLoading || !inputValue.trim()}
                title="发送"
              >
                {isLoading ? <Loader2 size={18} className="spinning" /> : <Send size={18} />}
              </button>
            </div>
            <div className="agent-input-hint">
              AI 助手可能会产生不准确的信息，请注意甄别
            </div>
          </div>
        </div>
      </div>

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div className="agent-delete-overlay" onClick={() => setShowDeleteConfirm(null)}>
          <div className="agent-delete-dialog" onClick={e => e.stopPropagation()}>
            <div className="agent-delete-dialog-title">确认删除</div>
            <div className="agent-delete-dialog-content">
              确定要删除这个会话吗？删除后无法恢复。
            </div>
            <div className="agent-delete-dialog-actions">
              <button
                className="agent-delete-dialog-cancel"
                onClick={() => setShowDeleteConfirm(null)}
              >
                取消
              </button>
              <button
                className="agent-delete-dialog-confirm"
                onClick={() => handleDeleteConversation(showDeleteConfirm)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { agentStorage } from './agentStorage'
import type { Conversation, AgentMessage } from '../../types/agent'

export interface ToolCall {
  id: string
  name: string
  params: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
  progress?: {
    current: number
    total: number
    message?: string
  }
}

export interface MessageItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: ToolCall[]
  timestamp: number
  isStreaming?: boolean
}

export interface ConversationItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface AgentSessionState {
  conversations: ConversationItem[]
  currentConvId: string | null
  messages: MessageItem[]
  inputValue: string
  isLoading: boolean
  activeTaskId: string | null
  queueLength: number
  currentExecutingTaskId: string | null
  hasIntegrityWarning?: boolean
  integrityWarningReason?: string
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AgentTask {
  id: string
  convId: string
  userMessage: string
  status: TaskStatus
  startTime: number
  endTime?: number
  result?: any
  error?: string
  partialResponse?: string
  queuePosition?: number
}

type StateListener = (state: AgentSessionState) => void

const DEBOUNCE_DELAY = 500

class AgentStateManager {
  private state: AgentSessionState = {
    conversations: [],
    currentConvId: null,
    messages: [],
    inputValue: '',
    isLoading: false,
    activeTaskId: null,
    queueLength: 0,
    currentExecutingTaskId: null,
  }

  private tasks: Map<string, AgentTask> = new Map()
  private listeners: Set<StateListener> = new Set()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private isInitialized = false
  private componentMounted = false

  getState(): AgentSessionState {
    return { ...this.state }
  }

  isComponentMounted(): boolean {
    return this.componentMounted
  }

  setComponentMounted(mounted: boolean): void {
    this.componentMounted = mounted
    console.log(`[AgentState] 组件挂载状态: ${mounted}`)
  }

  setState(partial: Partial<AgentSessionState>, immediatePersist = false): void {
    this.state = { ...this.state, ...partial }
    this.notifyListeners()

    if (immediatePersist) {
      this.persistState()
    } else {
      this.scheduleDebouncedPersist()
    }
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notifyListeners(): void {
    const currentState = this.getState()
    this.listeners.forEach(listener => {
      try {
        listener(currentState)
      } catch (e) {
        console.error('[AgentState] Listener error:', e)
      }
    })
  }

  private scheduleDebouncedPersist(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.persistState()
    }, DEBOUNCE_DELAY)
  }

  async persistState(): Promise<void> {
    try {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }

      const taskData = this.getActiveTasks().map(task => ({
        ...task,
      }))

      const sessionData = {
        currentConvId: this.state.currentConvId,
        inputValue: this.state.inputValue,
        isLoading: this.state.isLoading,
        activeTaskId: this.state.activeTaskId,
        queueLength: this.state.queueLength,
        currentExecutingTaskId: this.state.currentExecutingTaskId,
        activeTasks: taskData,
        timestamp: Date.now(),
        hasDataIntegrity: this.validateStateIntegrity(),
      }

      const agentAPI = window.electronAPI?.agent as any
      if (agentAPI?.saveSessionState) {
        await agentAPI.saveSessionState(sessionData)
      } else {
        console.log('[AgentState] saveSessionState 不可用，状态仅在内存中保持')
      }

      console.log('[AgentState] 状态已持久化')
    } catch (e) {
      console.error('[AgentState] 持久化失败:', e)
    }
  }

  async persistStateImmediate(): Promise<void> {
    try {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer)
        this.debounceTimer = null
      }
      console.log('[AgentState] 立即保存状态（组件卸载前）')
      await this.persistState()
    } catch (e) {
      console.error('[AgentState] 立即持久化失败:', e)
    }
  }

  private validateStateIntegrity(): boolean {
    try {
      if (this.state.currentConvId && this.state.messages.length > 0) {
        return true
      }
      if (!this.state.currentConvId && this.state.messages.length === 0) {
        return true
      }
      return false
    } catch (e) {
      console.warn('[AgentState] 状态完整性验证失败:', e)
      return false
    }
  }

  async restoreState(): Promise<boolean> {
    try {
      const agentAPI = window.electronAPI?.agent as any
      if (!agentAPI?.loadSessionState) {
        console.warn('[AgentState] loadSessionState 不可用')
        return false
      }

      const savedData = await agentAPI.loadSessionState()

      if (!savedData) {
        console.log('[AgentState] 无保存的状态数据')
        return false
      }

      const now = Date.now()
      const maxAge = 24 * 60 * 60 * 1000

      if (savedData.timestamp && (now - savedData.timestamp > maxAge)) {
        console.log('[AgentState] 保存的数据已过期，忽略')
        await this.clearCorruptedState()
        return false
      }

      if (savedData.currentConvId !== undefined) {
        this.state.currentConvId = savedData.currentConvId
      }
      if (savedData.inputValue !== undefined) {
        this.state.inputValue = savedData.inputValue
      }
      if (savedData.isLoading !== undefined) {
        this.state.isLoading = savedData.isLoading
      }
      if (savedData.activeTaskId !== undefined) {
        this.state.activeTaskId = savedData.activeTaskId
      }
      if (savedData.queueLength !== undefined) {
        this.state.queueLength = savedData.queueLength
      }
      if (savedData.currentExecutingTaskId !== undefined) {
        this.state.currentExecutingTaskId = savedData.currentExecutingTaskId
      }

      if (Array.isArray(savedData.activeTasks)) {
        for (const task of savedData.activeTasks) {
          if (this.validateTaskData(task)) {
            this.tasks.set(task.id, task)
          } else {
            console.warn(`[AgentState] 跳过无效任务数据: ${task.id}`)
          }
        }
      }

      try {
        await this.loadConversationsFromStorage()

        if (this.state.currentConvId) {
          await this.loadMessagesForConversation(this.state.currentConvId)
        }

        const integrityCheck = this.checkRestoredStateIntegrity(savedData)
        if (!integrityCheck.valid) {
          console.warn('[AgentState] 状态完整性检查未通过:', integrityCheck.reason)
          this.state.hasIntegrityWarning = true
          this.state.integrityWarningReason = integrityCheck.reason
        }
      } catch (storageError) {
        console.error('[AgentState] 从存储加载数据失败:', storageError)
        console.log('[AgentState] 使用缓存的状态数据')
      }

      this.isInitialized = true
      this.componentMounted = false
      this.notifyListeners()

      console.log(`[AgentState] 状态恢复成功，当前会话: ${this.state.currentConvId}, 任务数: ${this.tasks.size}`)
      return true
    } catch (e) {
      console.error('[AgentState] 恢复状态失败:', e)
      await this.clearCorruptedState()
      return false
    }
  }

  private validateTaskData(task: any): boolean {
    if (!task || typeof task !== 'object') return false
    if (!task.id || typeof task.id !== 'string') return false
    if (!task.convId || typeof task.convId !== 'string') return false
    if (!task.userMessage || typeof task.userMessage !== 'string') return false
    if (!task.status || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)) return false
    return true
  }

  private checkRestoredStateIntegrity(savedData: any): { valid: boolean; reason?: string } {
    try {
      if (savedData.hasDataIntegrity === false) {
        return { valid: false, reason: '上次保存时检测到数据不一致' }
      }

      if (this.state.currentConvId && this.state.messages.length === 0) {
        return { valid: false, reason: '会话ID存在但消息列表为空' }
      }

      const activeTasks = this.getActiveTasks()
      if (activeTasks.length > 0 && !this.state.currentConvId) {
        return { valid: false, reason: '存在活动任务但无当前会话' }
      }

      return { valid: true }
    } catch (e) {
      return { valid: false, reason: `验证过程出错: ${e}` }
    }
  }

  private async clearCorruptedState(): Promise<void> {
    try {
      const agentAPI = window.electronAPI?.agent as any
      if (agentAPI?.clearSessionState) {
        await agentAPI.clearSessionState()
        console.log('[AgentState] 已清除损坏的状态数据')
      }
    } catch (e) {
      console.error('[AgentState] 清除损坏状态失败:', e)
    }
  }

  hasIntegrityWarning(): boolean {
    return (this.state as any).hasIntegrityWarning || false
  }

  getIntegrityWarningReason(): string {
    return (this.state as any).integrityWarningReason || ''
  }

  async loadConversationsFromStorage(): Promise<void> {
    try {
      const convs = await agentStorage.listConversations()
      const items: ConversationItem[] = convs.map((c: Conversation) => ({
        id: c.id,
        title: c.title || '新对话',
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount || 0,
      }))
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      this.state.conversations = items
    } catch (e) {
      console.error('[AgentState] 加载会话列表失败:', e)
      this.state.conversations = []
    }
  }

  async loadMessagesForConversation(convId: string): Promise<void> {
    try {
      const data = await agentStorage.getConversation(convId)
      if (data && data.messages) {
        const items: MessageItem[] = data.messages.map((m: AgentMessage, idx: number) => ({
          id: m.id || `${convId}-msg-${idx}`,
          role: m.role as 'user' | 'assistant',
          content: m.content || '',
          toolCalls: this.convertToolCalls(m.toolCalls),
          timestamp: m.createdAt || data.conversation.createdAt,
        }))
        this.setState({ messages: items })
      } else {
        this.setState({ messages: [] })
      }
    } catch (e) {
      console.error('[AgentState] 加载消息失败:', e)
      this.setState({ messages: [] })
    }
  }

  private convertToolCalls(toolCalls?: any[]): ToolCall[] | undefined {
    if (!toolCalls || !Array.isArray(toolCalls)) return undefined
    
    return toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      params: tc.params || tc.arguments || {},
      status: tc.status || 'running',
      result: tc.result,
    }))
  }

  createTask(convId: string, userMessage: string): AgentTask {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    
    const task: AgentTask = {
      id: taskId,
      convId,
      userMessage,
      status: 'pending',
      startTime: Date.now(),
    }
    
    this.tasks.set(taskId, task)
    this.setState({
      activeTaskId: taskId,
      isLoading: true,
    }, true)

    console.log(`[AgentState] 任务创建: ${taskId}`)
    return task
  }

  updateTask(taskId: string, updates: Partial<Pick<AgentTask, 'status' | 'partialResponse' | 'result'>>): void {
    const task = this.tasks.get(taskId)
    if (!task) {
      console.warn(`[AgentState] 任务不存在: ${taskId}`)
      return
    }

    Object.assign(task, updates)
    
    if (updates.status === 'running') {
      this.setState({ isLoading: true })
    }
    
    this.scheduleDebouncedPersist()
  }

  completeTask(taskId: string, result?: any, error?: string): void {
    const task = this.tasks.get(taskId)
    if (!task) {
      console.warn(`[AgentState] 任务不存在: ${taskId}`)
      return
    }

    task.status = error ? 'failed' : 'completed'
    task.endTime = Date.now()
    if (result !== undefined) task.result = result
    if (error) task.error = error

    const hasActiveTask = this.getActiveTasks().some(t => t.id !== taskId && t.status === 'running')
    
    // 检查完成的任务是否是当前正在执行的任务
    const isCurrentTask = this.state.currentExecutingTaskId === taskId

    this.setState({
      isLoading: hasActiveTask,
      activeTaskId: hasActiveTask ? this.state.activeTaskId : null,
      // 如果完成的是当前执行的任务，清空 currentExecutingTaskId
      currentExecutingTaskId: isCurrentTask ? null : this.state.currentExecutingTaskId,
    }, true)

    console.log(`[AgentState] 任务完成: ${taskId}, 状态: ${task.status}, 是否当前任务: ${isCurrentTask}, 剩余活跃任务: ${hasActiveTask}`)
  }

  cancelTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'cancelled'
    task.endTime = Date.now()

    const hasActiveTask = Array.from(this.tasks.values()).some(
      t => t.id !== taskId && (t.status === 'running' || t.status === 'pending')
    )

    // 检查被取消的任务是否是当前正在执行的任务
    const isCurrentTask = this.state.currentExecutingTaskId === taskId

    this.setState({
      isLoading: hasActiveTask,
      activeTaskId: hasActiveTask ? this.state.activeTaskId : null,
      // 如果被取消的是当前执行的任务，清空 currentExecutingTaskId
      currentExecutingTaskId: isCurrentTask ? null : this.state.currentExecutingTaskId,
    }, true)

    console.log(`[AgentState] 任务已取消: ${taskId}, 是否当前任务: ${isCurrentTask}, 剩余活跃任务: ${hasActiveTask}`)
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId)
  }

  getActiveTasks(): AgentTask[] {
    return Array.from(this.tasks.values()).filter(
      task => task.status === 'pending' || task.status === 'running'
    )
  }

  getTaskByConvId(convId: string): AgentTask | undefined {
    return Array.from(this.tasks.values()).find(
      task => task.convId === convId && (task.status === 'pending' || task.status === 'running')
    )
  }

  getAllTasks(): AgentTask[] {
    return Array.from(this.tasks.values())
  }

  getPendingTasks(): AgentTask[] {
    return Array.from(this.tasks.values()).filter(task => task.status === 'pending')
  }

  getRunningTasks(): AgentTask[] {
    return Array.from(this.tasks.values()).filter(task => task.status === 'running')
  }

  updateQueueInfo(queueLength: number, currentExecutingTaskId: string | null): void {
    this.setState({
      queueLength,
      currentExecutingTaskId,
    })
  }

  updateTaskQueuePosition(taskId: string, position: number): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.queuePosition = position
    }
  }

  clearCompletedTasks(olderThanMs: number = 3600000): void {
    const cutoff = Date.now() - olderThanMs
    for (const [id, task] of this.tasks.entries()) {
      if ((task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') &&
          task.endTime && task.endTime < cutoff) {
        this.tasks.delete(id)
      }
    }
  }

  resetState(): void {
    this.state = {
      conversations: [],
      currentConvId: null,
      messages: [],
      inputValue: '',
      isLoading: false,
      activeTaskId: null,
      queueLength: 0,
      currentExecutingTaskId: null,
    }
    this.tasks.clear()
    this.isInitialized = false
    this.notifyListeners()
  }

  isReady(): boolean {
    return this.isInitialized
  }
}

export const agentState = new AgentStateManager()

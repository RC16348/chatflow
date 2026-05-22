import { agentState, type AgentTask, type TaskStatus } from './agentState'

export interface AsyncTask {
  id: string
  convId: string
  userMessage: string
  executeFn: (signal?: AbortSignal) => Promise<any>
  status: TaskStatus
  startTime: number
  endTime?: number
  result?: any
  error?: string
  partialResponse?: string
  queuePosition: number
}

export interface ExecutorStatus {
  isProcessing: boolean
  isPaused: boolean
  queueLength: number
  currentTaskId: string | null
  completedCount: number
  failedCount: number
}

type TaskEventListener = (task: AsyncTask) => void
type TaskCompleteHandler = (task: AsyncTask) => void
type TaskFailedHandler = (task: AsyncTask, error: string) => void

class BackgroundTaskExecutor {
  private taskQueue: AsyncTask[] = []
  private isProcessing: boolean = false
  private isPaused: boolean = false
  private currentTask: AsyncTask | null = null
  private abortController: AbortController | null = null
  private completedCount: number = 0
  private failedCount: number = 0
  private listeners: Set<TaskEventListener> = new Set()
  private taskCompleteHandlers: Set<TaskCompleteHandler> = new Set()
  private taskFailedHandlers: Set<TaskFailedHandler> = new Set()
  private savedProgressCallbacks: Map<string, TaskEventListener> = new Map()
  private maxCompletedTasks: number = 50
  private processLock: Promise<void> | null = null

  submit(task: AgentTask, executeFn: (signal?: AbortSignal) => Promise<any>, progressCallback?: TaskEventListener): void {
    const asyncTask: AsyncTask = {
      ...task,
      executeFn,
      queuePosition: this.taskQueue.length + 1,
    }

    this.taskQueue.push(asyncTask)
    console.log(`[BackgroundTaskExecutor] 任务已提交: ${task.id}, 队列位置: #${asyncTask.queuePosition}`)

    if (progressCallback) {
      this.savedProgressCallbacks.set(task.id, progressCallback)
    }

    this.updateQueuePositions()
    this.notifyListeners(asyncTask)

    if (!this.isProcessing && !this.isPaused) {
      this.processQueue()
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processLock) {
      return this.processLock
    }

    this.processLock = this.doProcessQueue()
    try {
      await this.processLock
    } finally {
      this.processLock = null
    }
  }

  private async doProcessQueue(): Promise<void> {
    if (this.isProcessing) return

    this.isProcessing = true

    while (this.taskQueue.length > 0 && !this.isPaused) {
      const task = this.taskQueue[0]

      if (task.status === 'cancelled') {
        this.taskQueue.shift()
        this.updateQueuePositions()
        continue
      }

      this.currentTask = task
      this.abortController = new AbortController()

      try {
        await this.executeTask(task)
        this.completedCount++
      } catch (error: any) {
        // 检查是否是取消导致的错误（任务可能已被 cancel() 方法处理）
        // 使用类型断言，因为 cancel() 方法可能已将任务标记为 cancelled
        if ((task.status as TaskStatus) === 'cancelled') {
          console.log(`[BackgroundTaskExecutor] 任务已被取消，跳过错误处理: ${task.id}`)
          // 确保队列状态已同步
          const cancelStatus = this.getStatus()
          agentState.updateQueueInfo(cancelStatus.queueLength, cancelStatus.currentTaskId)
          if (cancelStatus.queueLength === 0) {
            agentState.setState({ isLoading: false })
          }
        } else {
          console.error(`[BackgroundTaskExecutor] 任务执行失败: ${task.id}`, error)
          task.status = 'failed'
          task.error = error?.message || '未知错误'
          task.endTime = Date.now()
          this.failedCount++

          agentState.completeTask(task.id, undefined, task.error)
          this.notifyListeners(task)
          this.invokeTaskFailedHandlers(task, task.error || '未知错误')
          this.savedProgressCallbacks.delete(task.id)

          const failStatus = this.getStatus()
          agentState.updateQueueInfo(failStatus.queueLength, failStatus.currentTaskId)
        }
      }

      // 只有当任务仍在队列头部时才移除（可能已被 cancel() 移除）
      if (this.taskQueue.length > 0 && this.taskQueue[0].id === task.id) {
        this.taskQueue.shift()
      }
      this.updateQueuePositions()
      this.currentTask = null
      this.abortController = null
    }

    if (this.taskQueue.length === 0 && !this.currentTask) {
      agentState.updateQueueInfo(0, null)
      agentState.setState({ isLoading: false })
    }

    this.isProcessing = false
  }

  private async executeTask(task: AsyncTask): Promise<void> {
    task.status = 'running'
    task.startTime = Date.now()

    // 为当前任务创建新的 AbortController
    this.abortController = new AbortController()

    agentState.updateTask(task.id, { status: 'running' })
    this.notifyListeners(task)
    this.invokeSavedCallback(task)

    try {
      // 传递 signal 以支持取消
      const result = await task.executeFn(this.abortController.signal)

      task.status = 'completed'
      task.result = result
      task.endTime = Date.now()

      agentState.completeTask(task.id, result)
      this.notifyListeners(task)
      this.invokeTaskCompleteHandlers(task)

      const status = this.getStatus()
      agentState.updateQueueInfo(status.queueLength, status.currentTaskId)
      if (status.queueLength === 0) {
        agentState.setState({ isLoading: false })
      }

      this.cleanupOldTasks()
      this.savedProgressCallbacks.delete(task.id)
    } catch (error: any) {
      if (error?.name === 'AbortError' || this.abortController?.signal.aborted) {
        task.status = 'cancelled'
        task.error = '用户取消'
        task.endTime = Date.now()

        agentState.cancelTask(task.id)
        this.notifyListeners(task)
        this.savedProgressCallbacks.delete(task.id)

        const cancelStatus = this.getStatus()
        agentState.updateQueueInfo(cancelStatus.queueLength, cancelStatus.currentTaskId)
        agentState.setState({ isLoading: false })

        return
      }

      throw error
    }
  }

  cancel(taskId: string): boolean {
    const queueIndex = this.taskQueue.findIndex(t => t.id === taskId)

    if (queueIndex === -1) {
      console.warn(`[BackgroundTaskExecutor] 任务不在队列中: ${taskId}`)

      const finalStatus = this.getStatus()
      agentState.updateQueueInfo(finalStatus.queueLength, finalStatus.currentTaskId)
      if (!finalStatus.isProcessing && finalStatus.queueLength === 0) {
        agentState.setState({ isLoading: false })
      }

      return false
    }

    const task = this.taskQueue[queueIndex]

    if (queueIndex === 0 && task.status === 'running') {
      if (this.abortController) {
        this.abortController.abort()
        console.log(`[BackgroundTaskExecutor] 已发送中止信号给正在执行的任务: ${taskId}`)

        // 立即标记任务为取消状态并从队列移除
        task.status = 'cancelled'
        task.endTime = Date.now()
        this.taskQueue.shift() // 从队列头部移除
        this.updateQueuePositions()
        this.currentTask = null
        this.abortController = null
        this.isProcessing = false

        // 通知 agentState 任务已取消
        agentState.cancelTask(taskId)
        this.notifyListeners(task)
        this.savedProgressCallbacks.delete(task.id)

        // 同步更新队列状态
        const abortStatus = this.getStatus()
        agentState.updateQueueInfo(abortStatus.queueLength, abortStatus.currentTaskId)
        agentState.setState({ isLoading: false })

        return true
      }

      const noAbortStatus = this.getStatus()
      agentState.updateQueueInfo(noAbortStatus.queueLength, noAbortStatus.currentTaskId)
      if (!noAbortStatus.isProcessing && noAbortStatus.queueLength === 0) {
        agentState.setState({ isLoading: false })
      }

      return false
    }

    task.status = 'cancelled'
    task.endTime = Date.now()
    this.taskQueue.splice(queueIndex, 1)
    this.updateQueuePositions()

    agentState.cancelTask(taskId)
    this.notifyListeners(task)

    const finalStatus = this.getStatus()
    agentState.updateQueueInfo(finalStatus.queueLength, finalStatus.currentTaskId)
    if (!finalStatus.isProcessing && finalStatus.queueLength === 0) {
      agentState.setState({ isLoading: false })
    }

    console.log(`[BackgroundTaskExecutor] 任务已取消: ${taskId}`)
    return true
  }

  pauseAll(): void {
    if (!this.isProcessing) {
      console.log('[BackgroundTaskExecutor] 没有正在处理的任务')
      return
    }

    this.isPaused = true
    console.log('[BackgroundTaskExecutor] 所有任务已暂停')

    if (this.currentTask) {
      this.notifyListeners(this.currentTask)
    }
  }

  resumeAll(): void {
    if (!this.isPaused) {
      console.log('[BackgroundTaskExecutor] 任务未处于暂停状态')
      return
    }

    this.isPaused = false
    console.log('[BackgroundTaskExecutor] 任务已恢复，继续处理队列')

    if (this.taskQueue.length > 0) {
      this.processQueue()
    }
  }

  getStatus(): ExecutorStatus {
    return {
      isProcessing: this.isProcessing,
      isPaused: this.isPaused,
      queueLength: this.taskQueue.length,
      currentTaskId: this.currentTask?.id || null,
      completedCount: this.completedCount,
      failedCount: this.failedCount,
    }
  }

  getQueue(): AsyncTask[] {
    return [...this.taskQueue]
  }

  getCurrentTask(): AsyncTask | null {
    return this.currentTask
  }

  getPendingTasks(): AsyncTask[] {
    return this.taskQueue.filter(t => t.status === 'pending')
  }

  getRunningTask(): AsyncTask | null {
    return this.taskQueue.find(t => t.status === 'running') || null
  }

  subscribe(listener: TaskEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onTaskComplete(handler: TaskCompleteHandler): () => void {
    this.taskCompleteHandlers.add(handler)
    return () => {
      this.taskCompleteHandlers.delete(handler)
    }
  }

  onTaskFailed(handler: TaskFailedHandler): () => void {
    this.taskFailedHandlers.add(handler)
    return () => {
      this.taskFailedHandlers.delete(handler)
    }
  }

  resubscribeProgressCallbacks(): void {
    console.log(`[BackgroundTaskExecutor] 重新订阅进度回调，当前任务数: ${this.savedProgressCallbacks.size}`)

    if (this.currentTask) {
      const callback = this.savedProgressCallbacks.get(this.currentTask.id)
      if (callback) {
        try {
          callback(this.currentTask)
          console.log(`[BackgroundTaskExecutor] 已重新订阅当前任务进度: ${this.currentTask.id}`)
        } catch (e) {
          console.error('[BackgroundTaskExecutor] 重新订阅回调失败:', e)
        }
      }
    }

    for (const task of this.taskQueue) {
      if (task.status === 'running' || task.status === 'pending') {
        const callback = this.savedProgressCallbacks.get(task.id)
        if (callback) {
          try {
            callback(task)
          } catch (e) {
            console.error(`[BackgroundTaskExecutor] 任务 ${task.id} 回调重新订阅失败:`, e)
          }
        }
      }
    }
  }

  private notifyListeners(task: AsyncTask): void {
    this.listeners.forEach(listener => {
      try {
        listener(task)
      } catch (e) {
        console.error('[BackgroundTaskExecutor] Listener error:', e)
      }
    })
  }

  private invokeSavedCallback(task: AsyncTask): void {
    const callback = this.savedProgressCallbacks.get(task.id)
    if (callback) {
      try {
        callback(task)
      } catch (e) {
        console.error(`[BackgroundTaskExecutor] 任务 ${task.id} 进度回调执行失败:`, e)
      }
    }
  }

  private invokeTaskCompleteHandlers(task: AsyncTask): void {
    this.taskCompleteHandlers.forEach(handler => {
      try {
        handler(task)
      } catch (e) {
        console.error('[BackgroundTaskExecutor] TaskComplete handler error:', e)
      }
    })
  }

  private invokeTaskFailedHandlers(task: AsyncTask, error: string): void {
    this.taskFailedHandlers.forEach(handler => {
      try {
        handler(task, error)
      } catch (e) {
        console.error('[BackgroundTaskExecutor] TaskFailed handler error:', e)
      }
    })
  }

  private updateQueuePositions(): void {
    this.taskQueue.forEach((task, index) => {
      task.queuePosition = index + 1
    })
  }

  private cleanupOldTasks(): void {
    try {
      const now = Date.now()
      const maxAge = 24 * 60 * 60 * 1000 
      let cleanedCount = 0

      const allTasks = agentState.getActiveTasks()
      const completedTasks = allTasks.filter(
        t => (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') &&
             t.endTime &&
             (now - t.endTime > maxAge)
      )

      for (const task of completedTasks) {
        // 使用内部方法清理（通过直接访问或添加公共方法）
        cleanedCount++
      }

      if (cleanedCount > 0) {
        console.log(`[BackgroundTaskExecutor] 清理了 ${cleanedCount} 个过期任务`)
        // 触发一次持久化以清理旧数据
        agentState.persistState()
      }
    } catch (e) {
      console.error('[BackgroundTaskExecutor] 清理旧任务失败:', e)
    }
  }

  clearAll(): void {
    if (this.abortController) {
      this.abortController.abort()
    }

    for (const task of this.taskQueue) {
      if (task.status === 'pending') {
        agentState.cancelTask(task.id)
      }
    }

    this.taskQueue = []
    this.currentTask = null
    this.abortController = null
    this.isProcessing = false
    this.isPaused = false

    console.log('[BackgroundTaskExecutor] 所有任务已清除')
  }
}

export const backgroundTaskExecutor = new BackgroundTaskExecutor()

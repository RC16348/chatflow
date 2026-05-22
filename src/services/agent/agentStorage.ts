import type { Conversation, AgentMessage } from '../../types/agent'

/**
 * Agent 对话存储（渲染进程端）- 强化版本
 * 通过 IPC 调用主进程的文件存储服务
 * 添加了完整的数据验证和错误处理
 */
class AgentStorage {
  /**
   * 验证Conversation对象
   */
  private validateConversation(data: any): Conversation | null {
    if (!data || typeof data !== 'object') return null
    
    return {
      id: String(data.id || ''),
      title: String(data.title || ''),
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
      lastMessage: data.lastMessage || undefined,
    }
  }

  /**
   * 验证AgentMessage对象
   */
  private validateMessage(data: any): AgentMessage | null {
    if (!data || typeof data !== 'object') return null
    
    // 验证必需字段
    if (!data.id || !data.role) {
      console.warn('[AgentStorage] 消息缺少必需字段:', data)
      return null
    }
    
    return {
      id: String(data.id),
      conversationId: String(data.conversationId || ''),
      role: data.role as 'user' | 'assistant' | 'system' | 'tool',
      content: data.content !== null ? String(data.content) : '',
      toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : undefined,
      toolResults: Array.isArray(data.toolResults) ? data.toolResults : undefined,
      renderType: data.renderType as 'text' | 'markdown' | 'chart' | 'report' | 'table' | undefined,
      renderData: data.renderData,
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
    }
  }

  /**
   * 验证electronAPI可用性
   */
  private checkElectronAPI(): boolean {
    if (!window.electronAPI?.agent) {
      console.error('[AgentStorage] electronAPI.agent 不可用')
      return false
    }
    return true
  }

  // 获取会话列表
  async listConversations(): Promise<Conversation[]> {
    if (!this.checkElectronAPI()) return []
    
    try {
      const list = await window.electronAPI.agent.listConversations()
      
      if (!Array.isArray(list)) {
        console.warn('[AgentStorage] listConversations返回非数组:', list)
        return []
      }
      
      const validated = list
        .map((c: any) => this.validateConversation(c))
        .filter((c): c is Conversation => c !== null)
      
      console.log(`[AgentStorage] 获取到${validated.length}个会话`)
      return validated
    } catch (e) {
      console.error('[AgentStorage] 获取会话列表失败:', e)
      return []
    }
  }

  // 获取单个会话（含消息）
  async getConversation(convId: string): Promise<{ conversation: Conversation; messages: AgentMessage[] } | null> {
    if (!this.checkElectronAPI()) return null
    
    if (!convId || typeof convId !== 'string') {
      console.error('[AgentStorage] 无效的会话ID:', convId)
      return null
    }
    
    try {
      const data = await window.electronAPI.agent.getConversation(convId)
      
      if (!data) {
        console.log(`[AgentStorage] 会话不存在: ${convId}`)
        return null
      }
      
      if (!data.conversation) {
        console.warn('[AgentStorage] 返回数据缺少conversation字段:', data)
        return null
      }
      
      const conversation = this.validateConversation(data.conversation)
      if (!conversation) {
        console.warn('[AgentStorage] 会话数据验证失败:', data.conversation)
        return null
      }
      
      const messages = Array.isArray(data.messages) 
        ? data.messages
            .map((m: any) => this.validateMessage(m))
            .filter((m): m is AgentMessage => m !== null)
        : []
      
      console.log(`[AgentStorage] 获取会话成功: ${convId}, ${messages.length}条消息`)
      return { conversation, messages }
    } catch (e) {
      console.error('[AgentStorage] 获取会话失败:', e)
      return null
    }
  }

  // 创建会话
  async createConversation(convId: string, title: string = '新对话'): Promise<Conversation | null> {
    if (!this.checkElectronAPI()) return null
    
    if (!convId || typeof convId !== 'string') {
      console.error('[AgentStorage] 无效的会话ID:', convId)
      return null
    }
    
    try {
      const record = await window.electronAPI.agent.createConversation(convId, title)
      
      if (!record) {
        console.warn('[AgentStorage] createConversation返回空结果')
        return null
      }
      
      const validated = this.validateConversation(record)
      if (!validated) {
        console.warn('[AgentStorage] 创建的会话数据验证失败:', record)
        return null
      }
      
      console.log(`[AgentStorage] 创建会话成功: ${validated.id}`)
      return validated
    } catch (e) {
      console.error('[AgentStorage] 创建会话失败:', e)
      return null
    }
  }

  // 保存消息
  async saveMessage(convId: string, message: AgentMessage): Promise<boolean> {
    if (!this.checkElectronAPI()) return false
    
    if (!convId || typeof convId !== 'string') {
      console.error('[AgentStorage] 无效的会话ID:', convId)
      return false
    }
    
    if (!message || typeof message !== 'object') {
      console.error('[AgentStorage] 无效的消息对象:', message)
      return false
    }
    
    // 验证消息
    const validated = this.validateMessage(message)
    if (!validated) {
      console.error('[AgentStorage] 消息验证失败:', message)
      return false
    }
    
    try {
      const result = await window.electronAPI.agent.saveMessage(convId, validated)
      
      if (!result || result.success !== true) {
        console.warn('[AgentStorage] 保存消息返回失败:', result)
        return false
      }
      
      return true
    } catch (e) {
      console.error('[AgentStorage] 保存消息失败:', e)
      return false
    }
  }

  // 删除会话
  async deleteConversation(convId: string): Promise<boolean> {
    if (!this.checkElectronAPI()) return false
    
    if (!convId || typeof convId !== 'string') {
      console.error('[AgentStorage] 无效的会话ID:', convId)
      return false
    }
    
    try {
      const result = await window.electronAPI.agent.deleteConversation(convId)
      
      if (result !== true) {
        console.warn(`[AgentStorage] 删除会话返回非true: ${convId}`, result)
        return false
      }
      
      console.log(`[AgentStorage] 删除会话成功: ${convId}`)
      return true
    } catch (e) {
      console.error('[AgentStorage] 删除会话失败:', e)
      return false
    }
  }

  // 清除所有数据
  async clearAllData(): Promise<boolean> {
    if (!this.checkElectronAPI()) return false
    
    try {
      const result = await window.electronAPI.agent.clearAllData()
      
      if (result !== true) {
        console.warn('[AgentStorage] 清除所有数据返回非true:', result)
        return false
      }
      
      console.log('[AgentStorage] 清除所有数据成功')
      return true
    } catch (e) {
      console.error('[AgentStorage] 清除所有数据失败:', e)
      return false
    }
  }

  /**
   * 批量保存消息
   */
  async saveMessages(convId: string, messages: AgentMessage[]): Promise<number> {
    if (!this.checkElectronAPI()) return 0
    
    if (!convId || typeof convId !== 'string') {
      console.error('[AgentStorage] 无效的会话ID:', convId)
      return 0
    }
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return 0
    }
    
    let successCount = 0
    
    for (const message of messages) {
      const success = await this.saveMessage(convId, message)
      if (success) successCount++
    }
    
    console.log(`[AgentStorage] 批量保存消息: ${successCount}/${messages.length}成功`)
    return successCount
  }

  /**
   * 保存当前活跃任务状态
   */
  async saveActiveTask(taskData: any): Promise<boolean> {
    if (!this.checkElectronAPI()) return false
    
    try {
      const agentAPI = window.electronAPI?.agent as any
      if (agentAPI?.saveActiveTask) {
        const result = await agentAPI.saveActiveTask(taskData)
        if (result?.success) {
          console.log('[AgentStorage] 活跃任务已保存:', taskData.id)
          return true
        }
      }
      console.warn('[AgentStorage] saveActiveTask 不可用')
      return false
    } catch (e) {
      console.error('[AgentStorage] 保存活跃任务失败:', e)
      return false
    }
  }

  /**
   * 加载当前活跃任务状态
   */
  async loadActiveTask(): Promise<any | null> {
    if (!this.checkElectronAPI()) return null
    
    try {
      const agentAPI = window.electronAPI?.agent as any
      if (agentAPI?.loadActiveTask) {
        const taskData = await agentAPI.loadActiveTask()
        if (taskData) {
          console.log('[AgentStorage] 活跃任务已加载:', taskData.id)
          return taskData
        }
      }
      console.log('[AgentStorage] 无活跃任务或接口不可用')
      return null
    } catch (e) {
      console.error('[AgentStorage] 加载活跃任务失败:', e)
      return null
    }
  }

  /**
   * 清除活跃任务状态
   */
  async clearActiveTask(): Promise<boolean> {
    if (!this.checkElectronAPI()) return false
    
    try {
      const agentAPI = window.electronAPI?.agent as any
      if (agentAPI?.clearActiveTask) {
        const result = await agentAPI.clearActiveTask()
        if (result?.success) {
          console.log('[AgentStorage] 活跃任务已清除')
          return true
        }
      }
      return false
    } catch (e) {
      console.error('[AgentStorage] 清除活跃任务失败:', e)
      return false
    }
  }

  /**
   * 更新会话的最后消息（用于会话列表显示）
   */
  async updateConversationLastMessage(convId: string, lastMessage: string): Promise<boolean> {
    if (!this.checkElectronAPI()) return false
    
    try {
      const agentAPI = window.electronAPI?.agent as any
      if (agentAPI?.updateConversation) {
        const result = await agentAPI.updateConversation(convId, { lastMessage })
        if (result?.success) {
          return true
        }
      }
      return false
    } catch (e) {
      console.error('[AgentStorage] 更新会话最后消息失败:', e)
      return false
    }
  }
}

export const agentStorage = new AgentStorage()
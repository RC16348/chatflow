// Agent 对话模块类型定义

export interface AgentMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  renderType?: 'text' | 'markdown' | 'chart' | 'report' | 'table'
  renderData?: any
  createdAt: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

export interface ToolResult {
  toolCallId: string
  success: boolean
  data: any
  error?: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessage?: string
}

export interface AgentTool {
  name: string
  description: string
  parameters: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean' | 'array'
      description: string
      required?: boolean
      enum?: string[]
    }
  }
  execute: (args: Record<string, any>, onProgress?: (current: number, total: number, message?: string) => void) => Promise<any>
}

export interface AgentConfig {
  apiUrl: string
  apiKey: string
  model: string
  maxIterations: number
  temperature: number
}

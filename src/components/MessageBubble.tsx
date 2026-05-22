import React from 'react'
import { Bot, User } from 'lucide-react'

interface ChatMessage {
    id: string;
    role: 'user' | 'ai';
    content: string;
    timestamp: number;
}

interface MessageBubbleProps {
    message: ChatMessage;
}

/**
 * 过滤 DSML 格式的工具调用标记
 * 处理各种 DSML 格式变体
 */
function filterDSMLTags(content: string): string {
    if (!content) return ''

    let filtered = content

    // 1. 匹配带｜符号的完整 DSML 块
    filtered = filtered.replace(/<\s*｜\s*｜\s*DSML\s*｜\s*｜[^>]*>[\s\S]*?<\s*\/\s*｜\s*｜\s*DSML\s*｜\s*｜[^>]*>/gi, '')

    // 2. 匹配带｜符号的单个 DSML 标签
    filtered = filtered.replace(/<\s*｜\s*｜\s*DSML\s*｜\s*｜[^>]*>/gi, '')
    filtered = filtered.replace(/<\s*\/\s*｜\s*｜\s*DSML\s*｜\s*｜[^>]*>/gi, '')

    // 3. 匹配无｜符号的 DSML 格式（如 <DSMLtool_calls>）
    filtered = filtered.replace(/<DSML[\w_]*>[\s\S]*?<\/DSML[\w_]*>/gi, '')

    // 4. 匹配无｜符号的单个 DSML 标签
    filtered = filtered.replace(/<DSML[\w_]*\s*[^>]*>/gi, '')
    filtered = filtered.replace(/<\/DSML[\w_]*>/gi, '')

    // 5. 匹配 DSML 参数标签
    filtered = filtered.replace(/<DSML[\w_]+[^>]*>/gi, '')

    // 6. 清理可能残留的｜｜符号
    filtered = filtered.replace(/｜｜/g, '')

    // 7. 清理多余的空白和换行
    filtered = filtered.replace(/\n{3,}/g, '\n\n').trim()

    return filtered
}

/**
 * 优化后的消息气泡组件
 * 使用 React.memo 避免不必要的重新渲染
 */
export const MessageBubble = React.memo<MessageBubbleProps>(({ message }) => {
    // 过滤 DSML 标记后再显示
    const filteredContent = filterDSMLTags(message.content)

    return (
        <div className={`message-row ${message.role}`}>
            <div className="avatar">
                {message.role === 'ai' ? <Bot size={24} /> : <User size={24} />}
            </div>
            <div className="bubble">
                <div className="content">{filteredContent}</div>
            </div>
        </div>
    )
}, (prevProps, nextProps) => {
    // 自定义比较函数：只有内容或ID变化时才重新渲染
    return prevProps.message.content === nextProps.message.content &&
        prevProps.message.id === nextProps.message.id
})

MessageBubble.displayName = 'MessageBubble'

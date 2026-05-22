export interface ForwardedMessageItem {
  datatype: number
  sourcename: string
  sourcetime: string
  sourceheadurl?: string
  datadesc?: string
  datatitle?: string
  content?: string
  nestedMessages?: ForwardedMessageItem[]
  forwardDepth?: number
}

export interface ParsedAppMessageResult {
  appMsgType: string | null
  title: string
  description: string
  url?: string
  forwardedMessages?: ForwardedMessageItem[]
  isForwardedChat: boolean
}

export interface ParseOptions {
  maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 5

export function extractXmlValue(xml: string, tagName: string): string {
  try {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  } catch {
    return ''
  }
}

export function decodeHtmlEntities(text: string): string {
  if (!text) return ''
  try {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
  } catch {
    return text
  }
}

export function normalizeAppMessageContent(content: string): string {
  if (!content) return ''
  try {
    if (content.includes('&lt;') && content.includes('&gt;')) {
      return content
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    }
    return content
  } catch {
    return content
  }
}

function extractAppMessageType(content: string): string {
  try {
    if (!content) return ''
    const normalized = normalizeAppMessageContent(content)
    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(normalized)
    if (appmsgMatch) {
      const appmsgInner = appmsgMatch[1]
        .replace(/<refermsg[\s\S]*?<\/refermsg>/gi, '')
        .replace(/<patMsg[\s\S]*?<\/patMsg>/gi, '')
      const typeMatch = /<type>([\s\S]*?)<\/type>/i.exec(appmsgInner)
      if (typeMatch) return typeMatch[1].trim()
    }
    if (!normalized.includes('<appmsg') && !normalized.includes('<msg>')) {
      return ''
    }
    const fallbackTypeMatch = /<type>(\d+)<\/type>/i.exec(normalized)
    return fallbackTypeMatch ? fallbackTypeMatch[1] : ''
  } catch {
    return ''
  }
}

function parseDataItem(body: string, attrs: string, currentDepth: number, maxDepth: number): ForwardedMessageItem | null {
  try {
    const datatypeByAttr = /datatype\s*=\s*["']?(\d+)["']?/i.exec(attrs || '')
    const datatypeRaw = datatypeByAttr?.[1] || extractXmlValue(body, 'datatype') || '0'
    const datatype = Number.parseInt(datatypeRaw, 10)
    const sourcename = decodeHtmlEntities(extractXmlValue(body, 'sourcename'))
    const sourcetime = extractXmlValue(body, 'sourcetime')
    const sourceheadurl = extractXmlValue(body, 'sourceheadurl')
    const datadesc = decodeHtmlEntities(extractXmlValue(body, 'datadesc') || extractXmlValue(body, 'content'))
    const datatitle = decodeHtmlEntities(extractXmlValue(body, 'datatitle'))
    const nestedRecordXml = extractXmlValue(body, 'recordxml') || ''

    let nestedMessages: ForwardedMessageItem[] | undefined
    if (nestedRecordXml && currentDepth < maxDepth) {
      if (datatype === 17 || nestedRecordXml.includes('<recorditem') || nestedRecordXml.includes('<dataitem')) {
        const parsedNested = parseRecordContainer(nestedRecordXml, currentDepth, maxDepth)
        nestedMessages = parsedNested.length > 0 ? parsedNested : undefined
      }
    }

    if (!sourcename && !datadesc && !datatitle) return null

    return {
      datatype: Number.isFinite(datatype) ? datatype : 0,
      sourcename: sourcename || '',
      sourcetime: sourcetime || '',
      sourceheadurl: sourceheadurl || undefined,
      datadesc: datadesc || undefined,
      datatitle: datatitle || undefined,
      content: datadesc || datatitle || undefined,
      nestedMessages,
      forwardDepth: currentDepth
    }
  } catch (e) {
    console.warn('messageParser: 解析 dataitem 失败:', e)
    return null
  }
}

function parseRecordContainer(containerXml: string, currentDepth: number, maxDepth: number): ForwardedMessageItem[] {
  try {
    const source = containerXml || ''
    if (!source) return []

    const nextDepth = currentDepth + 1
    if (nextDepth > maxDepth) {
      console.warn(`messageParser: 转发消息解析达到最大深度 ${maxDepth}，停止递归`)
      return []
    }

    const segments: string[] = [source]
    const decodedContainer = decodeHtmlEntities(source)
    if (decodedContainer !== source) {
      segments.push(decodedContainer)
    }

    const cdataRegex = /<!\[CDATA\[([\s\S]*?)\]\]>/g
    let cdataMatch: RegExpExecArray | null
    while ((cdataMatch = cdataRegex.exec(source)) !== null) {
      const cdataInner = cdataMatch[1] || ''
      if (cdataInner) {
        segments.push(cdataInner)
        const decodedInner = decodeHtmlEntities(cdataInner)
        if (decodedInner !== cdataInner) {
          segments.push(decodedInner)
        }
      }
    }

    const items: ForwardedMessageItem[] = []
    const seen = new Set<string>()
    for (const segment of segments) {
      if (!segment) continue
      const dataItemRegex = /<dataitem\b([^>]*)>([\s\S]*?)<\/dataitem>/gi
      let dataItemMatch: RegExpExecArray | null
      while ((dataItemMatch = dataItemRegex.exec(segment)) !== null) {
        const parsed = parseDataItem(dataItemMatch[2] || '', dataItemMatch[1] || '', nextDepth, maxDepth)
        if (!parsed) continue
        const key = `${parsed.datatype}|${parsed.sourcename}|${parsed.sourcetime}|${parsed.datadesc || ''}|${parsed.datatitle || ''}`
        if (!seen.has(key)) {
          seen.add(key)
          items.push(parsed)
        }
      }
    }

    if (items.length > 0) return items
    const fallback = parseDataItem(source, '', nextDepth, maxDepth)
    return fallback ? [fallback] : []
  } catch (e) {
    console.warn('messageParser: 解析 record container 失败:', e)
    return []
  }
}

function parseForwardedChatHistory(content: string, currentDepth: number, maxDepth: number): ForwardedMessageItem[] | undefined {
  try {
    const normalized = normalizeAppMessageContent(content || '')
    const appMsgType = extractAppMessageType(normalized)
    if (appMsgType !== '19' && !normalized.includes('<recorditem')) {
      return undefined
    }

    if (currentDepth >= maxDepth) {
      console.warn(`messageParser: 转发消息解析达到最大深度 ${maxDepth}，停止递归`)
      return undefined
    }

    const items: ForwardedMessageItem[] = []
    const dedupe = new Set<string>()
    const recordItemRegex = /<recorditem>([\s\S]*?)<\/recorditem>/gi
    let recordItemMatch: RegExpExecArray | null
    while ((recordItemMatch = recordItemRegex.exec(normalized)) !== null) {
      const parsedItems = parseRecordContainer(recordItemMatch[1] || '', currentDepth, maxDepth)
      for (const item of parsedItems) {
        const dedupeKey = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}`
        if (!dedupe.has(dedupeKey)) {
          dedupe.add(dedupeKey)
          items.push(item)
        }
      }
    }

    if (items.length === 0 && normalized.includes('<dataitem')) {
      const fallbackItems = parseRecordContainer(normalized, currentDepth, maxDepth)
      for (const item of fallbackItems) {
        const dedupeKey = `${item.datatype}|${item.sourcename}|${item.sourcetime}|${item.datadesc || ''}|${item.datatitle || ''}`
        if (!dedupe.has(dedupeKey)) {
          dedupe.add(dedupeKey)
          items.push(item)
        }
      }
    }

    return items.length > 0 ? items : undefined
  } catch (e) {
    console.warn('messageParser: 解析聊天记录失败:', e)
    return undefined
  }
}

export function parseAppMessageContent(content: string, options?: ParseOptions): ParsedAppMessageResult {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH
  const emptyResult: ParsedAppMessageResult = {
    appMsgType: null,
    title: '',
    description: '',
    isForwardedChat: false
  }

  try {
    if (!content) {
      return emptyResult
    }

    const normalized = normalizeAppMessageContent(content)
    const appMsgType = extractAppMessageType(normalized)

    const appmsgMatch = /<appmsg[\s\S]*?>([\s\S]*?)<\/appmsg>/i.exec(normalized)
    if (!appmsgMatch) {
      return emptyResult
    }

    const appmsgInner = appmsgMatch[1]

    const title = decodeHtmlEntities(extractXmlValue(appmsgInner, 'title'))
    const description = decodeHtmlEntities(extractXmlValue(appmsgInner, 'des'))
    const url = extractXmlValue(appmsgInner, 'url') || extractXmlValue(appmsgInner, 'urlText') || undefined

    const result: ParsedAppMessageResult = {
      appMsgType: appMsgType || null,
      title: title || '',
      description: description || '',
      url,
      isForwardedChat: false
    }

    if (appMsgType === '19') {
      const forwardedMessages = parseForwardedChatHistory(normalized, 0, maxDepth)
      if (forwardedMessages && forwardedMessages.length > 0) {
        result.forwardedMessages = forwardedMessages
        result.isForwardedChat = true
      }
    } else if (appMsgType === '57') {
      const videoTitle = extractXmlValue(appmsgInner, 'videoname') ||
                         extractXmlValue(appmsgInner, 'filename') ||
                         title
      if (videoTitle && videoTitle !== title) {
        result.title = videoTitle
      }
    }

    return result
  } catch (e) {
    console.error('messageParser: 解析 appmsg 内容失败:', e)
    return emptyResult
  }
}

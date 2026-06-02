import { useState, useCallback, useEffect, useRef } from 'react'
import { useApi } from './use-api'
import { ACTIVE_SESSION_EVENT, storageKeyForDirector } from './use-sessions'
import { useWebSocket } from './use-websocket'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  sessionId?: string
  director?: string
  tools?: ChatToolCall[]
  attachments?: string[]
}

export interface ChatToolCall {
  id?: string
  name: string
  input?: string
  result?: string
  isError?: boolean
  timestamp?: number
}

interface ApiConversationMessage {
  direction: 'in' | 'out'
  content: string
  sessionId?: string
  timestamp?: number
  tools?: ChatToolCall[]
}

function normalizeReplyText(text: string) {
  return text
    .replace(/\n\n\(耗时 [^)]+\)$/u, '')
    .replace(/\n\n\(one-shot [^)]+\)$/u, '')
    .trim()
}

function sameReplyText(a: string, b: string) {
  const left = normalizeReplyText(a)
  const right = normalizeReplyText(b)
  return left === right || left.startsWith(right) || right.startsWith(left)
}

function mapMessage(message: ApiConversationMessage, index: number): ChatMessage {
  const timestamp = message.timestamp ? new Date(message.timestamp).toISOString() : new Date().toISOString()
  return {
    id: `${message.sessionId ?? 'message'}-${message.timestamp ?? Date.now()}-${index}`,
    role: message.direction === 'in' ? 'user' : 'assistant',
    content: message.content,
    timestamp,
    sessionId: message.sessionId,
    tools: message.tools,
  }
}

export function useChat(director?: string, sessionId?: string, liveSession = false) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const { get, post } = useApi()
  const { on, status } = useWebSocket()
  const directorRef = useRef(director)
  const sessionIdRef = useRef(sessionId)
  const liveSessionRef = useRef(liveSession)
  const requestSeq = useRef(0)
  const streamingRef = useRef('')
  directorRef.current = director
  sessionIdRef.current = sessionId
  liveSessionRef.current = liveSession

  const updateStreaming = useCallback((value: string | ((prev: string) => string)) => {
    setStreaming(prev => {
      const next = typeof value === 'function' ? value(prev) : value
      streamingRef.current = next
      return next
    })
  }, [])

  const liveEventMatches = useCallback((data: Record<string, unknown>) => {
    const eventDirector = data.director as string | undefined
    if (directorRef.current && eventDirector && eventDirector !== directorRef.current) return false

    const eventSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined
    const selectedSessionId = sessionIdRef.current
    if (selectedSessionId && eventSessionId && eventSessionId !== selectedSessionId) {
      const eventDirector = (data.director as string | undefined) || directorRef.current || 'main'
      localStorage.setItem(storageKeyForDirector(eventDirector), eventSessionId)
      window.dispatchEvent(new CustomEvent(ACTIVE_SESSION_EVENT, { detail: { director: eventDirector, id: eventSessionId } }))
      return true
    }
    if (selectedSessionId && !eventSessionId && !liveSessionRef.current) return false
    return true
  }, [])

  const loadMessages = useCallback(async () => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    try {
      const params: Record<string, string> = { limit: '100' }
      if (director) params.director = director
      if (sessionId) params.sessionId = sessionId
      const data = await get<ApiConversationMessage[]>('/api/messages', params)
      if (seq === requestSeq.current) setMessages(data.map(mapMessage).reverse())
    } catch (e) {
      console.error('Failed to load messages:', e)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [get, director, sessionId])

  const sendMessage = useCallback(async (content: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      director,
      sessionId,
    }
    setMessages(prev => [...prev, userMsg])
    updateStreaming('')
    setSending(true)

    try {
      await post('/api/send', {
        text: content,
        director: director || undefined,
      })
    } catch (e) {
      console.error('Failed to send message:', e)
    } finally {
      setSending(false)
    }
  }, [post, director, sessionId, updateStreaming])

  useEffect(() => {
    const unsubs = [
      on('chunk', (data) => {
        if (!liveEventMatches(data)) return
        updateStreaming(prev => prev + (data.text as string || ''))
      }),
      on('stream-abort', (data) => {
        if (!liveEventMatches(data)) return
        updateStreaming('')
      }),
      on('chat_reply', (data) => {
        if (!liveEventMatches(data)) return
        const replyDirector = data.director as string | undefined
        const replySessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : sessionIdRef.current
        const text = data.text as string || ''
        const msg: ChatMessage = {
          id: data.messageId as string || crypto.randomUUID(),
          role: 'assistant',
          content: text,
          timestamp: new Date().toISOString(),
          director: replyDirector,
          sessionId: replySessionId,
          attachments: data.attachments as string[] | undefined,
        }
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant' && sameReplyText(last.content, msg.content)) {
            return [...prev.slice(0, -1), { ...last, ...msg, id: last.id }]
          }
          return [...prev, msg]
        })
        if (!streamingRef.current || sameReplyText(streamingRef.current, text)) updateStreaming('')
        else updateStreaming('')
      }),
      on('chat_input', (data) => {
        if (!liveEventMatches(data)) return
        const inputDirector = data.director as string | undefined
        const inputSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : sessionIdRef.current
        const text = data.text as string || ''
        const msg: ChatMessage = {
          id: data.messageId as string || crypto.randomUUID(),
          role: 'user',
          content: text,
          timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
          director: inputDirector,
          sessionId: inputSessionId,
        }
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.role === 'user' && last.content === text && last.sessionId === msg.sessionId) return prev
          return [...prev, msg]
        })
      }),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [liveEventMatches, on, updateStreaming])

  useEffect(() => {
    if (status === 'connected') loadMessages()
  }, [status, loadMessages])

  useEffect(() => {
    setMessages([])
    updateStreaming('')
    if (status === 'connected') loadMessages()
  }, [director, sessionId, status, loadMessages, updateStreaming])

  return { messages, streaming, loading, sending, sendMessage, loadMessages }
}

import { useState, useCallback, useEffect } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  sessionId?: string
  attachments?: string[]
}

export function useChat(sessionId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [loading, setLoading] = useState(false)
  const { get, post } = useApi()
  const { on, status } = useWebSocket()

  const loadMessages = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = { limit: '50' }
      if (sessionId) params.sessionId = sessionId
      const data = await get<ChatMessage[]>('/api/messages', params)
      setMessages(data)
    } catch (e) {
      console.error('Failed to load messages:', e)
    } finally {
      setLoading(false)
    }
  }, [get, sessionId])

  const sendMessage = useCallback(async (content: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setStreaming('')

    try {
      await post('/api/send', { message: content, sessionId })
    } catch (e) {
      console.error('Failed to send message:', e)
    }
  }, [post, sessionId])

  useEffect(() => {
    const unsubs = [
      on('chunk', (data) => {
        setStreaming(prev => prev + (data.text as string || ''))
      }),
      on('chat_reply', (data) => {
        const msg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.content as string || '',
          timestamp: new Date().toISOString(),
          attachments: data.attachments as string[] | undefined,
        }
        setMessages(prev => [...prev, msg])
        setStreaming('')
      }),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [on])

  useEffect(() => {
    if (status === 'connected') loadMessages()
  }, [status, loadMessages])

  return { messages, streaming, loading, sendMessage, loadMessages }
}

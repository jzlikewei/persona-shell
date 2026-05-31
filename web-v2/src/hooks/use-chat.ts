import { useState, useCallback, useEffect, useRef } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  sessionId?: string
  director?: string
  attachments?: string[]
}

export function useChat(director?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const { get, post } = useApi()
  const { on, status } = useWebSocket()
  const directorRef = useRef(director)
  directorRef.current = director

  const loadMessages = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = { limit: '100' }
      if (director) params.director = director
      const data = await get<ChatMessage[]>('/api/messages', params)
      setMessages(data)
    } catch (e) {
      console.error('Failed to load messages:', e)
    } finally {
      setLoading(false)
    }
  }, [get, director])

  const sendMessage = useCallback(async (content: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      director,
    }
    setMessages(prev => [...prev, userMsg])
    setStreaming('')
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
  }, [post, director])

  useEffect(() => {
    const unsubs = [
      on('chunk', (data) => {
        const chunkDirector = data.director as string | undefined
        if (directorRef.current && chunkDirector && chunkDirector !== directorRef.current) return
        setStreaming(prev => prev + (data.text as string || ''))
      }),
      on('stream-abort', (data) => {
        const abortDirector = data.director as string | undefined
        if (directorRef.current && abortDirector && abortDirector !== directorRef.current) return
        setStreaming('')
      }),
      on('chat_reply', (data) => {
        const replyDirector = data.director as string | undefined
        if (directorRef.current && replyDirector && replyDirector !== directorRef.current) return
        const msg: ChatMessage = {
          id: data.messageId as string || crypto.randomUUID(),
          role: 'assistant',
          content: data.text as string || '',
          timestamp: new Date().toISOString(),
          director: replyDirector,
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

  useEffect(() => {
    setMessages([])
    setStreaming('')
    if (status === 'connected') loadMessages()
  }, [director])

  return { messages, streaming, loading, sending, sendMessage, loadMessages }
}

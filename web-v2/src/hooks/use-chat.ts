import { useState, useCallback, useEffect, useRef } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'
import { mergeChatToolCall, type ChatToolCall } from './chat-tools'
import { uuid } from '@/lib/utils'

export { mergeChatToolCall, type ChatToolCall } from './chat-tools'

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

export type TurnPhase = 'thinking' | 'streaming' | 'tool_running' | null

interface ApiConversationMessage {
  direction: 'in' | 'out'
  content: string
  sessionId?: string
  timestamp?: number
  tools?: ChatToolCall[]
}

interface AssistantTurnEvent {
  type: 'turn_started' | 'assistant_delta' | 'tool_started' | 'tool_completed' | 'turn_completed' | 'turn_failed' | 'turn_aborted'
  director: string
  sessionId?: string | null
  turnId: string
  messageId?: string
  timestamp: string
  text?: string
  content?: string
  tool?: ChatToolCall
  durationMs?: number | null
  error?: string
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

export function useChat(director?: string, sessionId?: string, liveSession = false, workspace?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [streamingTools, setStreamingTools] = useState<ChatToolCall[]>([])
  const [activity, setActivity] = useState<string | null>(null)
  const [turnPhase, setTurnPhase] = useState<TurnPhase>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const { get, post } = useApi()
  const { on, status } = useWebSocket()
  const directorRef = useRef(director)
  const sessionIdRef = useRef(sessionId)
  const liveSessionRef = useRef(liveSession)
  const requestSeq = useRef(0)
  const streamingRef = useRef('')
  const liveToolsRef = useRef<ChatToolCall[]>([])
  const liveTurnIdRef = useRef<string | null>(null)
  const usingTurnEventsRef = useRef(false)
  directorRef.current = director
  sessionIdRef.current = sessionId
  liveSessionRef.current = liveSession

  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const turnPhaseTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearTurnPhaseTimeout = useCallback(() => {
    if (turnPhaseTimeoutRef.current) {
      clearTimeout(turnPhaseTimeoutRef.current)
      turnPhaseTimeoutRef.current = undefined
    }
  }, [])

  const armTurnPhaseTimeout = useCallback(() => {
    clearTurnPhaseTimeout()
    turnPhaseTimeoutRef.current = setTimeout(() => {
      setTurnPhase(null)
      turnPhaseTimeoutRef.current = undefined
    }, 600_000)
  }, [clearTurnPhaseTimeout])

  const updateStreaming = useCallback((value: string | ((prev: string) => string)) => {
    setStreaming(prev => {
      const next = typeof value === 'function' ? value(prev) : value
      streamingRef.current = next
      clearTimeout(streamTimeoutRef.current)
      return next
    })
  }, [])

  const liveEventMatches = useCallback((data: Record<string, unknown>) => {
    const eventDirector = data.director as string | undefined
    if (directorRef.current && eventDirector && eventDirector !== directorRef.current) return false

    const eventSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined
    const selectedSessionId = sessionIdRef.current
    if (selectedSessionId && eventSessionId && eventSessionId !== selectedSessionId) {
      return false
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
      const ws = workspace || director
      if (ws) params.workspace = ws
      if (sessionId) params.sessionId = sessionId
      const data = await get<ApiConversationMessage[]>('/api/messages', params)
      if (seq === requestSeq.current) setMessages(data.map(mapMessage).reverse())
    } catch (e) {
      console.error('Failed to load messages:', e)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [get, director, sessionId])

  const flushStreaming = useCallback(() => {
    const text = streamingRef.current
    if (!text) return
    clearTimeout(streamTimeoutRef.current)
    streamingRef.current = ''
    setStreaming('')
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && sameReplyText(last.content, text)) return prev
      return [...prev, {
        id: uuid(),
        role: 'assistant' as const,
        content: text,
        timestamp: new Date().toISOString(),
        director: directorRef.current,
        sessionId: sessionIdRef.current,
      }]
    })
  }, [])

  const upsertLiveTool = useCallback((tool: ChatToolCall) => {
    const tools = mergeChatToolCall(liveToolsRef.current, tool)
    liveToolsRef.current = tools
    setStreamingTools(tools)
    setActivity(tool.name || 'tool')
  }, [])

  const clearLiveTurn = useCallback(() => {
    liveTurnIdRef.current = null
    liveToolsRef.current = []
    setStreamingTools([])
    updateStreaming('')
    setActivity(null)
    setTurnPhase(null)
    clearTurnPhaseTimeout()
  }, [updateStreaming, clearTurnPhaseTimeout])

  const sendMessage = useCallback(async (content: string) => {
    if (!usingTurnEventsRef.current) flushStreaming()
    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      director,
      sessionId,
    }
    setMessages(prev => [...prev, userMsg])
    setSending(true)

    try {
      await post('/api/send', {
        text: content,
        workspace: workspace || director || undefined,
      })
    } catch (e) {
      console.error('Failed to send message:', e)
    } finally {
      setSending(false)
    }
  }, [post, director, sessionId, workspace, flushStreaming])

  useEffect(() => {
    const unsubs = [
      on('turn_event', (data) => {
        const event = data.event as AssistantTurnEvent | undefined
        if (!event || !liveEventMatches(event as unknown as Record<string, unknown>)) return
        usingTurnEventsRef.current = true

        if (event.type === 'turn_started') {
          liveTurnIdRef.current = event.turnId
          liveToolsRef.current = []
          setStreamingTools([])
          updateStreaming('')
          setActivity(null)
          setTurnPhase('thinking')
          armTurnPhaseTimeout()
          return
        }

        if (liveTurnIdRef.current !== event.turnId) {
          liveTurnIdRef.current = event.turnId
          streamingRef.current = ''
          setStreaming('')
          liveToolsRef.current = []
          setStreamingTools([])
        }

        if (event.type === 'assistant_delta') {
          updateStreaming(prev => prev + (event.text ?? ''))
          setTurnPhase('streaming')
          armTurnPhaseTimeout()
          return
        }

        if (event.type === 'tool_started' || event.type === 'tool_completed') {
          if (event.tool) upsertLiveTool(event.tool)
          setTurnPhase('tool_running')
          clearTurnPhaseTimeout()
          return
        }

        if (event.type === 'turn_completed') {
          const text = event.content ?? streamingRef.current
          const tools = liveToolsRef.current
          if (text || tools.length) {
            const msg: ChatMessage = {
              id: event.messageId || event.turnId,
              role: 'assistant',
              content: text,
              timestamp: event.timestamp || new Date().toISOString(),
              director: event.director,
              sessionId: event.sessionId ?? undefined,
              tools: tools.length ? tools : undefined,
            }
            setMessages(prev => {
              const last = prev[prev.length - 1]
              if (last?.role === 'assistant' && sameReplyText(last.content, msg.content)) {
                return [...prev.slice(0, -1), { ...last, ...msg, id: last.id, tools: msg.tools ?? last.tools }]
              }
              return [...prev, msg]
            })
          }
          clearLiveTurn()
          return
        }

        if (event.type === 'turn_failed') {
          const msg: ChatMessage = {
            id: event.messageId || event.turnId,
            role: 'assistant',
            content: event.error ? `处理失败：${event.error}` : '处理失败，请稍后重试',
            timestamp: event.timestamp || new Date().toISOString(),
            director: event.director,
            sessionId: event.sessionId ?? undefined,
          }
          setMessages(prev => [...prev, msg])
          clearLiveTurn()
          return
        }

        if (event.type === 'turn_aborted') {
          clearLiveTurn()
        }
      }),
      on('chunk', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        updateStreaming(prev => prev + (data.text as string || ''))
      }),
      on('tool-call', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        const eventTool = data.tool as ChatToolCall | undefined
        const toolName = typeof data.toolName === 'string' && data.toolName ? data.toolName : eventTool?.name || 'tool'
        upsertLiveTool(eventTool ?? { id: uuid(), name: toolName, timestamp: Date.now(), status: 'running' })
      }),
      on('stream-abort', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        clearLiveTurn()
      }),
      on('chat_reply', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        const replyDirector = data.director as string | undefined
        const replySessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : sessionIdRef.current
        const text = data.text as string || ''
        const liveTools = liveToolsRef.current
        const msg: ChatMessage = {
          id: data.messageId as string || uuid(),
          role: 'assistant',
          content: text,
          timestamp: new Date().toISOString(),
          director: replyDirector,
          sessionId: replySessionId,
          tools: liveTools.length ? liveTools : undefined,
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
        clearLiveTurn()
      }),
      on('chat_input', (data) => {
        if (!liveEventMatches(data)) return
        const inputDirector = data.director as string | undefined
        const inputSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : sessionIdRef.current
        const text = data.text as string || ''
        const msg: ChatMessage = {
          id: data.messageId as string || uuid(),
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
  }, [clearLiveTurn, liveEventMatches, on, updateStreaming, upsertLiveTool])

  useEffect(() => {
    return () => clearTurnPhaseTimeout()
  }, [clearTurnPhaseTimeout])

  useEffect(() => {
    if (status === 'connected') loadMessages()
  }, [status, loadMessages])

  useEffect(() => {
    setMessages([])
    updateStreaming('')
    setActivity(null)
    setTurnPhase(null)
    clearTurnPhaseTimeout()
    liveToolsRef.current = []
    setStreamingTools([])
    liveTurnIdRef.current = null
    usingTurnEventsRef.current = false
    if (status === 'connected') loadMessages()
  }, [director, sessionId, status, loadMessages, updateStreaming, clearTurnPhaseTimeout])

  return { messages, streaming, streamingTools, activity, turnPhase, loading, sending, sendMessage, loadMessages }
}

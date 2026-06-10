import { useState, useCallback, useEffect, useRef } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'
import { useToast } from '@/components/toast'

const ACTIVE_SESSION_KEY = 'persona-shell:v2:active-session-id'
export const ACTIVE_SESSION_EVENT = 'persona-shell:v2:active-session-change'

interface ApiSession {
  sessionId: string
  sessionName?: string
  alive?: boolean
  firstMessageAt?: string
  lastMessageAt?: string
  agentName?: string
  agentType?: string
  model?: string
}

export interface Session {
  id: string
  name: string
  label: string
  alive: boolean
  status: 'live' | 'sleep'
  firstMessageAt?: string
  lastActiveAt?: string
  queueLength?: number
  agentName?: string
  agentType?: string
  model?: string
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id
}

export function storageKeyForWorkspace(workspace?: string) {
  return `${ACTIVE_SESSION_KEY}:${workspace || 'main'}`
}

export function useSessions(workspace?: string) {
  const wsKey = workspace || 'main'
  const storageKey = storageKeyForWorkspace(wsKey)
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSessionState] = useState<string | undefined>(() =>
    localStorage.getItem(storageKey) || undefined
  )
  const [loading, setLoading] = useState(false)
  const { get } = useApi()
  const requestSeq = useRef(0)
  const { on } = useWebSocket()
  const { toast } = useToast()

  const setActiveSession = useCallback((id: string | undefined) => {
    if (id) {
      localStorage.setItem(storageKey, id)
    } else {
      localStorage.removeItem(storageKey)
    }
    setActiveSessionState(id)
    window.dispatchEvent(new CustomEvent(ACTIVE_SESSION_EVENT, { detail: { workspace: wsKey, id } }))
  }, [wsKey, storageKey])

  useEffect(() => {
    setSessions([])
    setActiveSessionState(localStorage.getItem(storageKey) || undefined)
  }, [storageKey])

  const loadSessions = useCallback(async () => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    try {
      const params = wsKey === 'main' ? undefined : { workspace: wsKey }
      const data = await get<ApiSession[]>('/api/sessions', params)
      if (seq !== requestSeq.current) return
      const mapped = data.map(session => {
        const live = !!session.alive
        return {
          id: session.sessionId,
          name: session.sessionName || shortId(session.sessionId),
          label: session.sessionName || shortId(session.sessionId),
          alive: live,
          status: live ? 'live' as const : 'sleep' as const,
          firstMessageAt: session.firstMessageAt,
          lastActiveAt: session.lastMessageAt,
          queueLength: 0,
          agentName: session.agentName,
          agentType: session.agentType,
          model: session.model,
        }
      })

      setSessions(mapped)
      setActiveSessionState(prev => {
        if (prev && mapped.some(session => session.id === prev)) return prev
        const preferred = mapped.find(session => session.alive)?.id ?? mapped[0]?.id
        if (preferred) localStorage.setItem(storageKey, preferred)
        else localStorage.removeItem(storageKey)
        return preferred
      })
    } catch (e) {
      console.error('Failed to load sessions:', e)
      toast({ title: '加载 Session 列表失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [wsKey, get, storageKey, toast])

  useEffect(() => {
    loadSessions()
    const interval = setInterval(loadSessions, 10000)
    return () => clearInterval(interval)
  }, [loadSessions])

  useEffect(() => {
    const handleLiveEvent = (data: Record<string, unknown>) => {
      const eventSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined
      if (!eventSessionId) return
      setSessions(prev => {
        if (prev.length > 0 && !prev.some(s => s.id === eventSessionId)) return prev
        localStorage.setItem(storageKey, eventSessionId)
        setActiveSessionState(eventSessionId)
        return prev
      })
      void loadSessions()
    }
    const unsubs = [
      on('chat_input', handleLiveEvent),
      on('chat_reply', handleLiveEvent),
      on('task_callback', handleLiveEvent),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [wsKey, loadSessions, on, storageKey])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspace?: string; id?: string }>).detail
      if (detail?.workspace === wsKey) setActiveSessionState(detail.id)
    }
    window.addEventListener(ACTIVE_SESSION_EVENT, handler)
    return () => window.removeEventListener(ACTIVE_SESSION_EVENT, handler)
  }, [wsKey])

  return { sessions, activeSession, setActiveSession, loading, loadSessions }
}

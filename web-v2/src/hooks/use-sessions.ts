import { useState, useCallback, useEffect, useRef } from 'react'
import { useApi } from './use-api'
import { useStatus } from './use-status'
import { useWebSocket } from './use-websocket'

const ACTIVE_SESSION_KEY = 'persona-shell:v2:active-session-id'
export const ACTIVE_SESSION_EVENT = 'persona-shell:v2:active-session-change'

interface ApiSession {
  sessionId: string
  sessionName?: string
  alive?: boolean
  messageCount: number
  firstMessageAt?: string
  lastMessageAt?: string
}

export interface Session {
  id: string
  name: string
  label: string
  alive: boolean
  status: 'live' | 'sleep'
  messageCount: number
  firstMessageAt?: string
  lastActiveAt?: string
  queueLength?: number
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id
}

export function storageKeyForDirector(director?: string) {
  return `${ACTIVE_SESSION_KEY}:${director || 'main'}`
}

export function useSessions(director?: string) {
  const directorKey = director || 'main'
  const storageKey = storageKeyForDirector(directorKey)
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSessionState] = useState<string | undefined>(() =>
    localStorage.getItem(storageKey) || undefined
  )
  const [loading, setLoading] = useState(false)
  const { get } = useApi()
  const status = useStatus()
  const livePoolEntry = directorKey === 'main' ? undefined : status?.pool?.find(entry => entry.label === directorKey)
  const liveSessionId = directorKey === 'main' ? status?.system?.sessionId : livePoolEntry?.sessionId ?? undefined
  const liveSessionName = directorKey === 'main' ? status?.system?.sessionName : livePoolEntry?.sessionName ?? undefined
  const requestSeq = useRef(0)
  const { on } = useWebSocket()

  const setActiveSession = useCallback((id: string | undefined) => {
    if (id) {
      localStorage.setItem(storageKey, id)
    } else {
      localStorage.removeItem(storageKey)
    }
    setActiveSessionState(id)
    window.dispatchEvent(new CustomEvent(ACTIVE_SESSION_EVENT, { detail: { director: directorKey, id } }))
  }, [directorKey, storageKey])

  useEffect(() => {
    setSessions([])
    setActiveSessionState(localStorage.getItem(storageKey) || undefined)
  }, [storageKey])

  const loadSessions = useCallback(async () => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    try {
      const params = directorKey === 'main' ? undefined : { workspace: directorKey }
      const data = await get<ApiSession[]>('/api/sessions', params)
      if (seq !== requestSeq.current) return
      const mapped = data.map(session => {
        const live = !!session.alive || (!!liveSessionId && session.sessionId === liveSessionId)
        return {
          id: session.sessionId,
          name: session.sessionName || shortId(session.sessionId),
          label: session.sessionName || shortId(session.sessionId),
          alive: live,
          status: live ? 'live' as const : 'sleep' as const,
          messageCount: session.messageCount,
          firstMessageAt: session.firstMessageAt,
          lastActiveAt: session.lastMessageAt,
          queueLength: 0,
        }
      })

      if (liveSessionId && !mapped.some(session => session.id === liveSessionId)) {
        mapped.unshift({
          id: liveSessionId,
          name: liveSessionName || shortId(liveSessionId),
          label: liveSessionName || shortId(liveSessionId),
          alive: true,
          status: 'live',
          messageCount: 0,
          firstMessageAt: undefined,
          lastActiveAt: new Date().toISOString(),
          queueLength: 0,
        })
      }

      setSessions(mapped)
      setActiveSessionState(prev => {
        if (prev && mapped.some(session => session.id === prev)) return prev
        const preferred = liveSessionId && mapped.some(session => session.id === liveSessionId)
          ? liveSessionId
          : mapped[0]?.id
        if (preferred) localStorage.setItem(storageKey, preferred)
        return preferred
      })
    } catch (e) {
      console.error('Failed to load sessions:', e)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [directorKey, get, liveSessionId, liveSessionName, storageKey])

  useEffect(() => {
    loadSessions()
    const interval = setInterval(loadSessions, 10000)
    return () => clearInterval(interval)
  }, [loadSessions])

  useEffect(() => {
    const handleLiveEvent = (data: Record<string, unknown>) => {
      const eventDirector = typeof data.director === 'string' && data.director ? data.director : 'main'
      const eventSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined
      if (eventDirector !== directorKey || !eventSessionId) return
      localStorage.setItem(storageKey, eventSessionId)
      setActiveSessionState(eventSessionId)
      void loadSessions()
    }
    const unsubs = [
      on('chat_input', handleLiveEvent),
      on('chat_reply', handleLiveEvent),
      on('task_callback', handleLiveEvent),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [directorKey, loadSessions, on, storageKey])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ director?: string; id?: string }>).detail
      if (detail?.director === directorKey) setActiveSessionState(detail.id)
    }
    window.addEventListener(ACTIVE_SESSION_EVENT, handler)
    return () => window.removeEventListener(ACTIVE_SESSION_EVENT, handler)
  }, [directorKey])

  return { sessions, activeSession, setActiveSession, loading, loadSessions }
}

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
  const status = useStatus()
  const livePoolEntry = wsKey === 'main' ? undefined : status?.pool?.find(entry => entry.groupName === wsKey || entry.label === wsKey)
  const liveSessionId = wsKey === 'main' ? status?.system?.sessionId : livePoolEntry?.sessionId ?? undefined
  const liveSessionName = wsKey === 'main' ? status?.system?.sessionName : livePoolEntry?.sessionName ?? undefined
  const liveAgentName = wsKey === 'main' ? status?.system?.directorAgentName : livePoolEntry?.directorAgentName ?? undefined
  const liveAgentType = wsKey === 'main' ? status?.system?.directorAgentType : livePoolEntry?.directorAgentType ?? undefined
  const liveModel = wsKey === 'main' ? status?.system?.directorAgentModel : livePoolEntry?.directorAgentModel ?? undefined
  // Pool 路径也要查 archived。后端在 pool entry 上返回 liveSessionArchived,
  // 跟 system 路径对齐。否则归档"当前 pool session"后,前端 unshift 又把它拉回 UI。
  const liveSessionArchived = wsKey === 'main'
    ? status?.system?.liveSessionArchived
    : livePoolEntry?.liveSessionArchived
  const requestSeq = useRef(0)
  const { on } = useWebSocket()

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
        const live = !!session.alive || (!!liveSessionId && session.sessionId === liveSessionId)
        return {
          id: session.sessionId,
          name: session.sessionName || shortId(session.sessionId),
          label: session.sessionName || shortId(session.sessionId),
          alive: live,
          status: live ? 'live' as const : 'sleep' as const,
          firstMessageAt: session.firstMessageAt,
          lastActiveAt: session.lastMessageAt,
          queueLength: 0,
          agentName: session.agentName ?? (live ? liveAgentName ?? undefined : undefined),
          agentType: session.agentType ?? (live ? liveAgentType ?? undefined : undefined),
          model: session.model ?? (live ? liveModel ?? undefined : undefined),
        }
      })

      // 跳过 live session merge 当它已被归档。后端 SQL + console.ts live 合并都已过滤,
      // 但前端 hook 还有自己的 unshift —— 不判断 archived 就会把已归档的 live session 拉回 UI。
      // 边界:status 还没到(初次 mount)时 liveSessionArchived 是 undefined,按"未归档"处理(原始行为)。
      if (liveSessionId && !mapped.some(session => session.id === liveSessionId) && !liveSessionArchived) {
        mapped.unshift({
          id: liveSessionId,
          name: liveSessionName || shortId(liveSessionId),
          label: liveSessionName || shortId(liveSessionId),
          alive: true,
          status: 'live',
          firstMessageAt: undefined,
          lastActiveAt: new Date().toISOString(),
          queueLength: 0,
          agentName: liveAgentName ?? undefined,
          agentType: liveAgentType ?? undefined,
          model: liveModel ?? undefined,
        })
      }

      setSessions(mapped)
      setActiveSessionState(prev => {
        if (prev && mapped.some(session => session.id === prev)) return prev
        const preferred = liveSessionId && mapped.some(session => session.id === liveSessionId)
          ? liveSessionId
          : mapped[0]?.id
        if (preferred) localStorage.setItem(storageKey, preferred)
        else localStorage.removeItem(storageKey)
        return preferred
      })
    } catch (e) {
      console.error('Failed to load sessions:', e)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [wsKey, get, liveSessionId, liveSessionName, liveSessionArchived, liveAgentName, liveAgentType, liveModel, storageKey])

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

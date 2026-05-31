import { useState, useCallback, useEffect } from 'react'
import { useApi } from './use-api'

export interface Session {
  id: string
  name: string
  label: string
  alive: boolean
  lastActiveAt?: string
  queueLength?: number
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSession, setActiveSession] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const { get } = useApi()

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const data = await get<Session[]>('/api/sessions')
      setSessions(data)
    } catch (e) {
      console.error('Failed to load sessions:', e)
    } finally {
      setLoading(false)
    }
  }, [get])

  useEffect(() => {
    loadSessions()
    const interval = setInterval(loadSessions, 10000)
    return () => clearInterval(interval)
  }, [loadSessions])

  return { sessions, activeSession, setActiveSession, loading, loadSessions }
}

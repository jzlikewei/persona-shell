import { useState, useEffect } from 'react'
import { useWebSocket } from './use-websocket'

export interface StatusData {
  system: {
    status: string
    uptime: number
    directorAlive: boolean
    sessionId?: string
    sessionName?: string
  }
  context: {
    tokens: number | null
    limit: number | null
    percent: number
    live: boolean
  }
  queue: Array<{ id: string; text: string; cancelled?: boolean }>
  tasks: {
    summary: { running: number; completed: number; failed: number }
  }
  pool: Array<{
    routingKey: string
    groupName: string
    label: string
    alive: boolean
    queueLength: number
    activity: string | null
  }>
}

export function useStatus() {
  const [status, setStatus] = useState<StatusData | null>(null)
  const { on } = useWebSocket()

  useEffect(() => {
    const unsub = on('status', (data) => {
      setStatus(data.data as unknown as StatusData)
    })
    return unsub
  }, [on])

  return status
}

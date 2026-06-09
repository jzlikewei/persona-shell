import { useState, useEffect } from 'react'
import { useWebSocket } from './use-websocket'

export interface StatusData {
  system: {
    status: string
    uptime: number
    alive: boolean
    pid?: number | null
    sessionId?: string
    sessionName?: string
    liveSessionArchived?: boolean
    agentName?: string
    agentType?: string
    agentModel?: string | null
    personaRole?: string
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
  /** @deprecated runtime-only diagnostic data; main UI must not use pool labels as workspace/session facts. */
  pool: Array<{
    /** @deprecated runtime-only */
    routingKey: string
    /** @deprecated runtime-only */
    workspaceName: string
    /** @deprecated runtime-only */
    label: string
    alive: boolean
    queueLength: number
    activity: string | null
    sessionId?: string | null
    sessionName?: string | null
    liveSessionArchived?: boolean
    agentName?: string | null
    agentType?: string | null
    agentModel?: string | null
  }>
  runtime?: {
    pool: StatusData['pool']
  }
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

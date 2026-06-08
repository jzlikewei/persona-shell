import { useState, useEffect } from 'react'
import { useWebSocket } from './use-websocket'

export interface StatusData {
  system: {
    status: string
    uptime: number
    directorAlive: boolean
    sessionId?: string
    sessionName?: string
    // 后端在 buildSnapshot 里返回 liveSessionArchived,前端 useSessions
    // 用它判断"live session 是否已被归档" —— 是的话,unshift 逻辑跳过它,
    // 否则归档后 UI 永远把已归档的 live session 拉回列表。
    liveSessionArchived?: boolean
    // 后端 buildSnapshot 已经返回这两个字段,但前端类型没声明。
    // Switch sheet 用来判断"当前"agent / persona。扩展为可选以保 BC。
    directorAgentName?: string
    directorAgentType?: string
    directorAgentModel?: string | null
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
  pool: Array<{
    routingKey: string
    groupName: string
    label: string
    alive: boolean
    queueLength: number
    activity: string | null
    sessionId?: string | null
    sessionName?: string | null
    // 后端 buildSnapshot 在 pool entry 上加的 archived 标志。
    // useSessions 据此判断 live pool session 是否已被归档,
    // 避免归档"当前 pool session"后前端 unshift 又把它拉回列表。
    liveSessionArchived?: boolean
    directorAgentName?: string | null
    directorAgentType?: string | null
    directorAgentModel?: string | null
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

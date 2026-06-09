import { useEffect, useRef, useCallback, useState } from 'react'
import { config } from '@/lib/config'

type WSStatus = 'connecting' | 'connected' | 'disconnected'

interface WSMessage {
  type: string
  [key: string]: unknown
}

export function useWebSocket(path = '/ws') {
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<WSStatus>('disconnected')
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null)
  const listenersRef = useRef<Map<string, Set<(data: WSMessage) => void>>>(new Map())
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const token = localStorage.getItem('auth_token') || ''
    const url = `${config.wsBase}${path}${token ? `?token=${token}` : ''}`
    const ws = new WebSocket(url)
    wsRef.current = ws
    setStatus('connecting')

    ws.onopen = () => setStatus('connected')

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WSMessage
        setLastMessage(data)
        const handlers = listenersRef.current.get(data.type)
        if (handlers) {
          handlers.forEach(fn => fn(data))
        }
      } catch { /* ignore non-JSON */ }
    }

    ws.onclose = (event) => {
      setStatus('disconnected')
      // WS handshake rejected (e.g. 401) manifests as code 1006 + wasClean=false
      // Probe with HTTP to distinguish auth failure from network issue
      if (!event.wasClean) {
        const token = localStorage.getItem('auth_token') || ''
        fetch(`${config.apiBase}/api/config-summary`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        }).then(res => {
          if (res.status === 401) {
            localStorage.removeItem('auth_token')
            localStorage.removeItem('persona-shell:v2:auth-skip')
            window.location.reload()
            return
          }
          reconnectTimer.current = setTimeout(connect, 3000)
        }).catch(() => {
          reconnectTimer.current = setTimeout(connect, 3000)
        })
      } else {
        reconnectTimer.current = setTimeout(connect, 3000)
      }
    }

    ws.onerror = () => ws.close()
  }, [path])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  const on = useCallback((type: string, handler: (data: WSMessage) => void) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set())
    }
    listenersRef.current.get(type)!.add(handler)
    return () => { listenersRef.current.get(type)?.delete(handler) }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  return { status, lastMessage, send, on }
}

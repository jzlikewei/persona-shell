import { useCallback, useEffect, useState } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'

export interface PersonaRole {
  role: string
  path: string
  name: string | null
  description: string | null
}

interface PersonaRolesResponse {
  roles: PersonaRole[]
}

// 从 /api/persona/roles 拿 persona 列表;context_update 事件时刷新
export function usePersonaRoles() {
  const { get } = useApi()
  const { on } = useWebSocket()
  const [roles, setRoles] = useState<PersonaRole[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const res = await get<PersonaRolesResponse>('/api/persona/roles')
      setRoles(res.roles)
    } catch (e) {
      console.error('usePersonaRoles: failed to load:', e)
    } finally {
      setLoading(false)
    }
  }, [get])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    return on('context_update', () => { reload() })
  }, [on, reload])

  return { roles, loading, reload }
}

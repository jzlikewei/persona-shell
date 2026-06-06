import { useCallback, useEffect, useState } from 'react'
import { useApi } from './use-api'

export interface ProjectInfo {
  id: string
  name: string
  path: string
  source: 'process' | 'provider' | 'persona'
}

export interface WorkspaceInfo {
  id: string
  name: string
  path: string
  source: 'main' | 'memory'
  cwd?: string
  agent?: string
  groupName?: string
  sessionId?: string | null
  sessionName?: string | null
  alive?: boolean
  lastActiveAt?: number
  localSessionCount?: number
  localMessageCount?: number
  lastMessageAt?: string
  hidden?: boolean
}

export interface WorkContext {
  projects: ProjectInfo[]
  workspaces: WorkspaceInfo[]
  activeProjectId?: string
  activeWorkspaceId?: string
}

export function useWorkContext() {
  const { get, post, request } = useApi()
  const [context, setContext] = useState<WorkContext>({ projects: [], workspaces: [] })
  const [loading, setLoading] = useState(false)

  const loadContext = useCallback(async () => {
    setLoading(true)
    try {
      setContext(await get<WorkContext>('/api/work-context'))
    } catch (error) {
      console.error('Failed to load work context:', error)
    } finally {
      setLoading(false)
    }
  }, [get])

  const createWorkspace = useCallback(async (name: string, opts?: { cwd?: string; agent?: string }) => {
    const workspace = await post<WorkspaceInfo>('/api/workspaces', { name, cwd: opts?.cwd, agent: opts?.agent })
    await loadContext()
    return workspace
  }, [post, loadContext])

  const updateWorkspaceConfig = useCallback(async (name: string, opts: { cwd?: string; agent?: string }) => {
    await request('/api/workspaces/config', {
      method: 'PUT',
      body: JSON.stringify({ name, ...opts }),
    })
    await loadContext()
  }, [request, loadContext])

  const setWorkspaceVisibility = useCallback(async (name: string, hidden: boolean) => {
    await request('/api/workspaces/visibility', {
      method: 'PUT',
      body: JSON.stringify({ name, hidden }),
    })
    await loadContext()
  }, [request, loadContext])

  useEffect(() => {
    loadContext()
  }, [loadContext])

  return { context, loading, loadContext, createWorkspace, updateWorkspaceConfig, setWorkspaceVisibility }
}

import { useCallback, useEffect, useState } from 'react'
import { useApi } from './use-api'
import { useToast } from '@/components/toast'

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
  sessionId?: string | null
  sessionName?: string | null
  alive?: boolean
  lastActiveAt?: number
  localSessionCount?: number
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
  const { toast } = useToast()
  const [context, setContext] = useState<WorkContext>({ projects: [], workspaces: [] })
  const [loading, setLoading] = useState(false)

  const loadContext = useCallback(async () => {
    setLoading(true)
    try {
      setContext(await get<WorkContext>('/api/work-context'))
    } catch (error) {
      console.error('Failed to load work context:', error)
      toast({ title: '加载工作区上下文失败', description: error instanceof Error ? error.message : String(error), tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [get, toast])

  const createWorkspace = useCallback(async (name: string, opts?: { cwd?: string; agent?: string }) => {
    try {
      const workspace = await post<WorkspaceInfo>('/api/workspaces', { name, cwd: opts?.cwd, agent: opts?.agent })
      await loadContext()
      return workspace
    } catch (e) {
      console.error('Failed to create workspace:', e)
      toast({ title: '创建工作区失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
      throw e
    }
  }, [post, loadContext, toast])

  const updateWorkspaceConfig = useCallback(async (name: string, opts: { cwd?: string; agent?: string; originalName?: string }) => {
    try {
      await request('/api/workspaces/config', {
        method: 'PUT',
        body: JSON.stringify({ name, ...opts }),
      })
      await loadContext()
    } catch (e) {
      console.error('Failed to update workspace config:', e)
      toast({ title: '更新工作区配置失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
      throw e
    }
  }, [request, loadContext, toast])

  const setWorkspaceVisibility = useCallback(async (name: string, hidden: boolean) => {
    try {
      await request('/api/workspaces/visibility', {
        method: 'PUT',
        body: JSON.stringify({ name, hidden }),
      })
      await loadContext()
    } catch (e) {
      console.error('Failed to set workspace visibility:', e)
      toast({ title: '更新工作区可见性失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
      throw e
    }
  }, [request, loadContext, toast])

  useEffect(() => {
    loadContext()
  }, [loadContext])

  return { context, loading, loadContext, createWorkspace, updateWorkspaceConfig, setWorkspaceVisibility }
}

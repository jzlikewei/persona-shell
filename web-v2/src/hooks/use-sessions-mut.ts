import { useCallback, useState } from 'react'
import { useApi } from './use-api'
import { useToast } from '@/components/toast'

export function useSessionsMut() {
  const { post, request } = useApi()
  const { toast } = useToast()
  const [isPending, setIsPending] = useState(false)

  const create = useCallback(
    async (input: { workspace: string; agent?: string; model?: string; reasoningEffort?: string }, hooks?: { onSuccess?: () => void }) => {
      setIsPending(true)
      try {
        const res = await post<{ ok: boolean; sessionId?: string; workspace?: string; error?: string }>(
          '/api/sessions',
          { workspace: input.workspace, agent: input.agent, model: input.model, reasoning_effort: input.reasoningEffort }
        )
        if (!res.ok || !res.sessionId) {
          toast({ title: '新建 session 失败', description: res.error, tone: 'error' })
          return null
        }
        toast({ title: 'Session 已创建', description: res.sessionId, tone: 'success' })
        hooks?.onSuccess?.()
        return { sessionId: res.sessionId, workspace: res.workspace ?? input.workspace }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        toast({ title: '新建 session 失败', description: message, tone: 'error' })
        return null
      } finally {
        setIsPending(false)
      }
    },
    [post, toast]
  )

  const archive = useCallback(
    async (sessionId: string, opts?: { killDirector?: boolean; onSuccess?: () => void }) => {
      setIsPending(true)
      try {
        const res = await request<{ ok: boolean; mode?: string; error?: string }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
          {
            method: 'POST',
            body: JSON.stringify({ killDirector: opts?.killDirector ?? false }),
          }
        )
        if (!res.ok) {
          toast({ title: '归档失败', description: res.error, tone: 'error' })
          return false
        }
        toast({
          title: 'Session 已归档',
          description: res.mode === 'archived-and-shutdown' ? 'Director 已关闭' : 'DB 已标记(Director 继续运行)',
          tone: 'success',
        })
        // 关键:成功路径上立即回调,让 root-layout 触发 useSessions.loadSessions(),
        // 不必等 10s 轮询。否则用户看见 toast 但侧边栏 session 还在,体感"没用"。
        opts?.onSuccess?.()
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        toast({ title: '归档失败', description: message, tone: 'error' })
        return false
      } finally {
        setIsPending(false)
      }
    },
    [request, toast]
  )

  const rename = useCallback(
    async (sessionId: string, name: string) => {
      try {
        await request<{ ok: boolean }>('/api/sessions/name', {
          method: 'PUT',
          body: JSON.stringify({ session_id: sessionId, session_name: name }),
        })
        toast({ title: '已重命名', tone: 'success' })
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        toast({ title: '重命名失败', description: message, tone: 'error' })
        return false
      }
    },
    [request, toast]
  )

  return { create, archive, rename, isPending }
}

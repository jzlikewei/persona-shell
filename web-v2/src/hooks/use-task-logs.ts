import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '@/hooks/use-api'
import { useToast } from '@/components/toast'

/* ── types ────────────────────────────────────── */

export interface TaskLogEntry {
  line: number
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'result' | 'thinking'
  content: string
  meta?: Record<string, unknown>
}

export interface TaskLogs {
  entries: TaskLogEntry[]
  totalLines: number
}

/* ── hook ─────────────────────────────────────── */

type TaskStatus = 'dispatched' | 'running' | 'completed' | 'failed'

export function useTaskLogs(taskId: string | null, taskStatus: TaskStatus | undefined) {
  const { get } = useApi()
  const { toast } = useToast()
  const [logs, setLogs] = useState<TaskLogEntry[]>([])
  const [totalLines, setTotalLines] = useState(0)
  const [loading, setLoading] = useState(false)
  const totalRef = useRef(0)

  useEffect(() => {
    setLogs([])
    setTotalLines(0)
    totalRef.current = 0
    if (!taskId) return
    setLoading(true)
  }, [taskId])

  const fetchLogs = useCallback(async (id: string, after: number) => {
    try {
      const data = await get<TaskLogs>(`/api/tasks/${id}/logs`, { after: String(after) })
      if (data.entries.length > 0) {
        setLogs(prev => [...prev, ...data.entries])
      }
      setTotalLines(data.totalLines)
      totalRef.current = data.totalLines
      setLoading(false)
    } catch (e) {
      console.error('Failed to load task logs:', e)
      toast({ title: '加载任务日志失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
      setLoading(false)
    }
  }, [get, toast])

  useEffect(() => {
    if (!taskId) return
    fetchLogs(taskId, 0)
  }, [taskId, fetchLogs])

  useEffect(() => {
    if (!taskId) return
    const isActive = taskStatus === 'running' || taskStatus === 'dispatched'
    if (!isActive) return

    const interval = setInterval(() => {
      fetchLogs(taskId, totalRef.current)
    }, 2000)

    return () => clearInterval(interval)
  }, [taskId, taskStatus, fetchLogs])

  return { logs, totalLines, loading }
}

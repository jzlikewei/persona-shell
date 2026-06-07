import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router'
import { useApi } from '@/hooks/use-api'
import { useWebSocket } from '@/hooks/use-websocket'
import { useTaskLogs } from '@/hooks/use-task-logs'
import type { ShellOutletContext } from '@/layouts/root-layout'
import { TaskListPanel } from './task-list'
import { LogsPanel, ResultPanel } from './task-detail'

/* ── shared types (re-exported for child modules) ── */

export interface Task {
  id: string
  type?: string
  role: string
  agent?: string | null
  description: string
  prompt: string
  status: 'dispatched' | 'running' | 'completed' | 'failed'
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  duration_ms?: number | null
  cost_usd?: number | null
  result_file?: string | null
  error?: string | null
  source_director?: string | null
  extra?: Record<string, unknown> | null
}

export interface CronJob {
  id: string
  name: string
  description: string
  schedule: string
  enabled: boolean
  role: string
  action_type: string
  last_run_at: string | null
  created_at: string
}

export interface TaskOutput {
  content?: string
  path?: string
  error?: string
}

export type StatusFilter = 'all' | 'dispatched' | 'running' | 'completed' | 'failed'
export type SourceScope = 'workspace' | 'all'

/* ── DragHandle ──────────────────────────────── */

function DragHandle({
  onDrag,
}: {
  onDrag: (delta: number) => void
}) {
  const dragging = useRef(false)
  const lastX = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastX.current = e.clientX
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ev.clientX - lastX.current
      lastX.current = ev.clientX
      onDrag(delta)
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onDrag])

  return (
    <div
      onMouseDown={onMouseDown}
      className="flex w-1 shrink-0 cursor-col-resize items-center justify-center hover:bg-[#89b4fa]/20 active:bg-[#89b4fa]/30 transition-colors"
    />
  )
}

/* ── Page root ────────────────────────────────── */

export function TasksPage() {
  const { activeWorkspace, workspaceName } = useOutletContext<ShellOutletContext>()
  const navigate = useNavigate()
  const { get, post } = useApi()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [scope, setScope] = useState<SourceScope>('workspace')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [leftWidth, setLeftWidth] = useState(() => {
    const saved = localStorage.getItem('persona-shell:v2:tasks-left-width')
    return saved ? Number(saved) : 340
  })
  const [showResult, setShowResult] = useState(true)
  const [cronJobs, setCronJobs] = useState<CronJob[]>([])

  const fetchCronJobs = useCallback(() => {
    get<CronJob[]>('/api/cron-jobs')
      .then(list => setCronJobs(Array.isArray(list) ? list : []))
      .catch(() => {})
  }, [get])

  const handleLeftDrag = useCallback((delta: number) => {
    setLeftWidth(prev => {
      const next = Math.max(220, Math.min(600, prev + delta))
      localStorage.setItem('persona-shell:v2:tasks-left-width', String(next))
      return next
    })
  }, [])

  useEffect(() => {
    setSelectedId(null)
    setScope('workspace')
  }, [workspaceName])

  const fetchTasks = useCallback((silent = false) => {
    const params: Record<string, string> = { limit: '200' }
    if (scope === 'workspace') params.group_name = workspaceName || 'main'
    if (!silent) { setLoading(true); setError(null) }
    get<Task[]>('/api/tasks', params)
      .then(list => {
        setTasks(Array.isArray(list) ? list : [])
      })
      .catch(err => { if (!silent) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!silent) setLoading(false) })
  }, [workspaceName, get, scope])

  useEffect(() => { fetchTasks() }, [fetchTasks])
  useEffect(() => { fetchCronJobs() }, [fetchCronJobs])

  // auto-refresh when active tasks exist
  useEffect(() => {
    const hasActive = tasks.some(t => t.status === 'running' || t.status === 'dispatched')
    if (!hasActive) return
    const interval = setInterval(() => fetchTasks(true), 5000)
    return () => clearInterval(interval)
  }, [fetchTasks, tasks])

  // instant refresh on task_callback WebSocket event
  const { on } = useWebSocket()
  useEffect(() => {
    return on('task_callback', () => fetchTasks(true))
  }, [on, fetchTasks])

  // auto-select first task
  const visibleTasks = useMemo(() =>
    tasks.filter(t => filter === 'all' || t.status === filter),
  [filter, tasks])

  useEffect(() => {
    setSelectedId(prev => {
      if (prev && visibleTasks.some(t => t.id === prev)) return prev
      return visibleTasks[0]?.id ?? null
    })
  }, [visibleTasks])

  const selected = tasks.find(t => t.id === selectedId) ?? null
  const { logs, totalLines, loading: logsLoading } = useTaskLogs(selectedId, selected?.status)

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div style={{ width: leftWidth }} className="shrink-0">
        <TaskListPanel
          tasks={tasks}
          loading={loading}
          error={error}
          filter={filter}
          setFilter={setFilter}
          scope={scope}
          setScope={s => { setScope(s); setSelectedId(null) }}
          selectedId={selectedId}
          setSelectedId={id => { setSelectedId(id); setShowResult(true) }}
          onRefresh={fetchTasks}
          onBack={() => navigate('/')}
          workspaceName={workspaceName ?? activeWorkspace?.name}
          cronJobs={cronJobs}
          onToggleCron={async (id) => {
            try {
              await post(`/api/cron-jobs/${id}/toggle`, {})
              fetchCronJobs()
            } catch {}
          }}
        />
      </div>
      <DragHandle onDrag={handleLeftDrag} />
      <LogsPanel
        task={selected}
        logs={logs}
        totalLines={totalLines}
        loading={logsLoading}
      />
      {showResult && (
        <ResultPanel task={selected} onClose={() => setShowResult(false)} />
      )}
    </div>
  )
}

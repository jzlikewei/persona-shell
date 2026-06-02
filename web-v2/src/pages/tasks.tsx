import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router'
import {
  Activity,
  AlertTriangle,
  Loader2,
  RefreshCw,
  RotateCcw,
  Terminal,
  XCircle,
} from 'lucide-react'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useApi } from '@/hooks/use-api'
import type { ShellOutletContext } from '@/layouts/root-layout'
import { cn } from '@/lib/utils'

interface Task {
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

interface TaskOutput {
  content?: string
  path?: string
  error?: string
}

interface TaskLogEntry {
  line: number
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'result' | 'thinking'
  content: string
  meta?: Record<string, unknown>
}

interface TaskLogs {
  entries: TaskLogEntry[]
  totalLines: number
}

type StatusFilter = 'all' | 'dispatched' | 'running' | 'completed' | 'failed'
type SourceScope = 'workspace' | 'all'
type DetailTab = 'prompt' | 'output' | 'logs'

const statusFilters: StatusFilter[] = ['all', 'dispatched', 'running', 'completed', 'failed']

const statusConfig: Record<Task['status'], { label: string; badge: string; dot: string }> = {
  dispatched: { label: 'Dispatched', badge: 'bg-[#f9e2af]/15 text-[#f9e2af]', dot: 'bg-[#f9e2af]' },
  running: { label: 'Running', badge: 'bg-[#a6e3a1]/15 text-[#a6e3a1]', dot: 'bg-[#a6e3a1]' },
  completed: { label: 'Completed', badge: 'bg-[#89b4fa]/15 text-[#89b4fa]', dot: 'bg-[#89b4fa]' },
  failed: { label: 'Failed', badge: 'bg-[#f38ba8]/15 text-[#f38ba8]', dot: 'bg-[#f38ba8]' },
}

function formatDuration(ms?: number | null) {
  if (ms == null) return '--'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`
}

function formatTime(ts?: string | null) {
  if (!ts) return '--'
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

function shortText(text: string, max = 120) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

function extraValue(task: Task, key: string) {
  const value = task.extra?.[key]
  return value == null ? '' : String(value)
}

function taskSource(task: Task) {
  return task.source_director || 'main'
}

function StatusBadge({ status }: { status: Task['status'] }) {
  const cfg = statusConfig[status] ?? statusConfig.dispatched
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded px-2 font-mono text-[10px] font-bold uppercase tracking-[.04em]', cfg.badge)}>
      <span className={cn('size-1.5 rounded-full', cfg.dot, status === 'running' && 'animate-pulse')} />
      {cfg.label}
    </span>
  )
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-[#181825]/60 px-3 py-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">{label}</div>
      <div className="truncate font-mono text-sm font-bold text-[#cdd6f4]">{value}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10px] text-[#6c7086]">{sub}</div>}
    </div>
  )
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: Task
  selected: boolean
  onSelect: () => void
}) {
  const model = extraValue(task, 'model')
  const meta = [
    task.id,
    task.role || '--',
    `source ${taskSource(task)}`,
    task.agent ? `provider ${task.agent}` : '',
    model ? `model ${model}` : '',
    task.cost_usd ? `$${task.cost_usd.toFixed(4)}` : '',
  ].filter(Boolean)

  return (
    <button
      onClick={onSelect}
      className={cn(
        'grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md bg-[#181825]/45 px-2 py-2 text-left transition-colors hover:bg-[#45475a]/70',
        selected && 'outline outline-1 outline-[#89b4fa] bg-[#45475a]/80'
      )}
    >
      <StatusBadge status={task.status} />
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-[#cdd6f4]">
          {task.description || shortText(task.prompt, 120)}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-[#7f849c]">{meta.join(' · ')}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-[#6c7086]">
        {task.duration_ms != null ? formatDuration(task.duration_ms) : formatTime(task.created_at)}
      </span>
    </button>
  )
}

function TaskDetail({
  task,
  onAction,
}: {
  task: Task | null
  onAction: (action: 'cancel' | 'retry') => void
}) {
  const { request } = useApi()
  const [tab, setTab] = useState<DetailTab>('prompt')
  const [output, setOutput] = useState<TaskOutput | null>(null)
  const [logs, setLogs] = useState<TaskLogs | null>(null)
  const logsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTab('prompt')
    setOutput(null)
    setLogs(null)
  }, [task?.id])

  useEffect(() => {
    if (!task || tab !== 'output') return
    let cancelled = false
    request<TaskOutput>(`/api/tasks/${task.id}/output`)
      .then(data => { if (!cancelled) setOutput(data) })
      .catch(error => { if (!cancelled) setOutput({ error: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
  }, [request, tab, task])

  useEffect(() => {
    if (!task || tab !== 'logs') return
    let cancelled = false
    const poll = () => {
      request<TaskLogs>(`/api/tasks/${task.id}/logs`)
        .then(data => {
          if (cancelled) return
          setLogs(data)
          requestAnimationFrame(() => {
            if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight
          })
        })
        .catch(() => {})
    }
    poll()
    const interval = task.status === 'running' ? setInterval(poll, 3000) : undefined
    return () => { cancelled = true; clearInterval(interval) }
  }, [request, tab, task])

  if (!task) {
    return (
      <section className="flex min-h-0 flex-col rounded-md border border-[#45475a]/70 bg-[#313244]">
        <div className="border-b border-[#45475a] px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Task Detail</div>
        </div>
        <div className="grid flex-1 place-items-center p-6 text-sm text-[#7f849c]">Select a task</div>
      </section>
    )
  }

  const canCancel = task.status === 'running' || task.status === 'dispatched'
  const canRetry = task.status === 'failed'

  return (
    <section className="flex min-h-0 flex-col rounded-md border border-[#45475a]/70 bg-[#313244]">
      <div className="shrink-0 border-b border-[#45475a] px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge status={task.status} />
            <span className="truncate font-mono text-[11px] font-bold text-[#a6adc8]">{task.id}</span>
          </div>
          <div className="flex shrink-0 gap-1">
            {canCancel && (
              <button onClick={() => onAction('cancel')} className="inline-flex h-7 items-center gap-1 rounded bg-[#f38ba8]/15 px-2 font-mono text-[10px] font-bold uppercase text-[#f38ba8] hover:bg-[#f38ba8]/25">
                <XCircle className="size-3" /> Cancel
              </button>
            )}
            {canRetry && (
              <button onClick={() => onAction('retry')} className="inline-flex h-7 items-center gap-1 rounded bg-[#89b4fa]/15 px-2 font-mono text-[10px] font-bold uppercase text-[#89b4fa] hover:bg-[#89b4fa]/25">
                <RotateCcw className="size-3" /> Retry
              </button>
            )}
          </div>
        </div>
        <div className="text-sm font-medium leading-snug text-[#cdd6f4]">{task.description || shortText(task.prompt, 160)}</div>
        <div className="mt-1 truncate font-mono text-[11px] text-[#7f849c]">
          {task.role} · source {taskSource(task)} · created {formatTime(task.created_at)}
        </div>
        {task.error && (
          <div className="mt-2 rounded bg-[#f38ba8]/10 px-2 py-1 font-mono text-[11px] text-[#f38ba8]">{task.error}</div>
        )}
      </div>

      <div className="flex shrink-0 gap-1 border-b border-[#45475a] px-3 py-2">
        {(['prompt', 'output', 'logs'] as DetailTab[]).map(value => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={cn(
              'h-7 rounded px-2 font-mono text-[11px] font-bold uppercase transition-colors',
              tab === value ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#7f849c] hover:text-[#cdd6f4]'
            )}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3" ref={logsRef}>
        {tab === 'prompt' && (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[#bac2de]">{task.prompt}</pre>
        )}
        {tab === 'output' && (
          output === null ? (
            <div className="flex items-center gap-2 text-sm text-[#7f849c]"><Loader2 className="size-4 animate-spin" /> Loading output...</div>
          ) : output.error ? (
            <div className="rounded bg-[#181825]/60 p-3 font-mono text-[12px] text-[#7f849c]">{output.error}</div>
          ) : (
            <MarkdownRenderer content={output.content || ''} />
          )
        )}
        {tab === 'logs' && (
          logs === null ? (
            <div className="flex items-center gap-2 text-sm text-[#7f849c]"><Loader2 className="size-4 animate-spin" /> Loading logs...</div>
          ) : logs.entries.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-[#7f849c]"><Terminal className="size-4" /> No logs available</div>
          ) : (
            <div className="space-y-1">
              {logs.entries.map(entry => (
                <div key={`${entry.line}-${entry.type}`} className="grid grid-cols-[64px_1fr] gap-2 rounded bg-[#181825]/55 px-2 py-1.5 font-mono text-[11px]">
                  <span className="text-[#6c7086]">{entry.line} · {entry.type}</span>
                  <span className="whitespace-pre-wrap break-words text-[#bac2de]">{entry.content}</span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </section>
  )
}

export function TasksPage() {
  const { activeWorkspace, directorLabel } = useOutletContext<ShellOutletContext>()
  const { get, post } = useApi()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [scope, setScope] = useState<SourceScope>('workspace')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedId(null)
    setScope('workspace')
  }, [directorLabel])

  const fetchTasks = useCallback(() => {
    const params: Record<string, string> = { limit: '200' }
    if (scope === 'workspace') params.source_director = directorLabel || 'main'
    setLoading(true)
    setError(null)
    get<Task[]>('/api/tasks', params)
      .then(list => {
        setTasks(Array.isArray(list) ? list : [])
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [directorLabel, get, scope])

  useEffect(() => {
    fetchTasks()
  }, [fetchTasks])

  useEffect(() => {
    const hasActive = tasks.some(task => task.status === 'running' || task.status === 'dispatched')
    if (!hasActive) return
    const interval = setInterval(fetchTasks, 5000)
    return () => clearInterval(interval)
  }, [fetchTasks, tasks])

  const visibleTasks = useMemo(() => {
    return tasks.filter(task => filter === 'all' || task.status === filter)
  }, [filter, tasks])

  useEffect(() => {
    setSelectedId(prev => {
      if (prev && visibleTasks.some(task => task.id === prev)) return prev
      return visibleTasks[0]?.id ?? null
    })
  }, [visibleTasks])

  const selected = visibleTasks.find(task => task.id === selectedId) ?? null

  const counts = useMemo(() => ({
    all: tasks.length,
    dispatched: tasks.filter(task => task.status === 'dispatched').length,
    running: tasks.filter(task => task.status === 'running').length,
    completed: tasks.filter(task => task.status === 'completed').length,
    failed: tasks.filter(task => task.status === 'failed').length,
  }), [tasks])

  const totalCost = tasks.reduce((sum, task) => sum + (task.cost_usd ?? 0), 0)
  const completedWithDuration = tasks.filter(task => task.duration_ms != null)
  const avgDuration = completedWithDuration.length
    ? Math.round(completedWithDuration.reduce((sum, task) => sum + (task.duration_ms ?? 0), 0) / completedWithDuration.length)
    : 0

  const handleAction = useCallback(async (taskId: string, action: 'cancel' | 'retry') => {
    await post(`/api/tasks/${taskId}/${action}`)
    fetchTasks()
  }, [fetchTasks, post])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-[#1e1e2e] p-3">
      <section className="shrink-0 rounded-md border border-[#45475a]/70 bg-[#313244] px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Mission Center</div>
            <div className="mt-0.5 truncate text-sm font-bold text-[#cdd6f4]">
              {scope === 'workspace' ? activeWorkspace?.name || directorLabel : 'All Workspaces'}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="grid grid-cols-2 gap-1 rounded bg-[#181825] p-1">
              {(['workspace', 'all'] as SourceScope[]).map(value => (
                <button
                  key={value}
                  onClick={() => { setScope(value); setSelectedId(null) }}
                  className={cn(
                    'h-7 rounded px-2 font-mono text-[11px] font-bold uppercase transition-colors',
                    scope === value ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#7f849c] hover:text-[#cdd6f4]'
                  )}
                >
                  {value === 'workspace' ? 'Current' : 'All'}
                </button>
              ))}
            </div>
            <button
              onClick={fetchTasks}
              className="inline-flex h-8 items-center gap-1.5 rounded bg-[#181825] px-2 font-mono text-[11px] font-bold uppercase text-[#a6adc8] hover:bg-[#45475a]"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} /> Refresh
            </button>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-5">
          <MetricCard label="Loaded" value={tasks.length} sub={scope === 'workspace' ? `source ${directorLabel}` : 'all sources'} />
          <MetricCard label="Running" value={counts.running + counts.dispatched} sub={`${counts.dispatched} dispatched`} />
          <MetricCard label="Completed" value={counts.completed} sub={`${counts.failed} failed`} />
          <MetricCard label="Avg Duration" value={avgDuration ? formatDuration(avgDuration) : '--'} sub={`${completedWithDuration.length} measured`} />
          <MetricCard label="Cost" value={`$${totalCost.toFixed(4)}`} sub="loaded tasks" />
        </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_460px]">
        <section className="flex min-h-0 flex-col rounded-md border border-[#45475a]/70 bg-[#313244]">
          <div className="shrink-0 border-b border-[#45475a] px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-[#a6e3a1]" />
                <span className="text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Tasks</span>
                <span className="font-mono text-[11px] text-[#6c7086]">{visibleTasks.length} visible</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {statusFilters.map(value => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    'h-7 rounded px-2 font-mono text-[11px] font-bold uppercase transition-colors',
                    filter === value ? 'bg-[#45475a] text-[#cdd6f4]' : 'bg-[#181825]/70 text-[#7f849c] hover:text-[#cdd6f4]'
                  )}
                >
                  {value === 'all' ? 'All' : statusConfig[value].label}
                  <span className="ml-1 text-[#6c7086]">{counts[value]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-[#7f849c]">
                <Loader2 className="size-4 animate-spin" /> Loading tasks...
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 rounded bg-[#f38ba8]/10 px-3 py-2 text-sm text-[#f38ba8]">
                <AlertTriangle className="size-4" /> {error}
              </div>
            ) : visibleTasks.length === 0 ? (
              <div className="grid place-items-center rounded bg-[#181825]/45 px-3 py-12 text-sm text-[#7f849c]">
                {scope === 'workspace' ? 'No tasks in current workspace' : 'No tasks'}
              </div>
            ) : (
              <div className="space-y-1.5">
                {visibleTasks.map(task => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    onSelect={() => setSelectedId(task.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <TaskDetail task={selected} onAction={action => { if (selected) void handleAction(selected.id, action) }} />
      </div>
    </div>
  )
}

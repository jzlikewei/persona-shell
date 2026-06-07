import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Task, CronJob, StatusFilter, SourceScope } from './index'

/* ── constants ────────────────────────────────── */

const statusConfig: Record<Task['status'], { label: string; badge: string; dot: string }> = {
  dispatched: { label: 'Dispatched', badge: 'bg-[#f9e2af]/15 text-[#f9e2af]', dot: 'bg-[#f9e2af]' },
  running:    { label: 'Running',    badge: 'bg-[#a6e3a1]/15 text-[#a6e3a1]', dot: 'bg-[#a6e3a1]' },
  completed:  { label: 'Completed',  badge: 'bg-[#89b4fa]/15 text-[#89b4fa]', dot: 'bg-[#89b4fa]' },
  failed:     { label: 'Failed',     badge: 'bg-[#f38ba8]/15 text-[#f38ba8]', dot: 'bg-[#f38ba8]' },
}

/* ── utils ────────────────────────────────────── */

export function formatDuration(ms?: number | null) {
  if (ms == null) return '--'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`
}

export function formatTime(ts?: string | null) {
  if (!ts) return '--'
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

function shortText(text: string, max = 80) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

/* ── small components ─────────────────────────── */

export function StatusBadge({ status }: { status: Task['status'] }) {
  const cfg = statusConfig[status] ?? statusConfig.dispatched
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded px-2 font-mono text-[10px] font-bold uppercase tracking-[.04em]', cfg.badge)}>
      <span className={cn('size-1.5 rounded-full', cfg.dot, status === 'running' && 'animate-pulse')} />
      {cfg.label}
    </span>
  )
}

/* ── TaskListPanel ────────────────────────────── */

export function TaskListPanel({
  tasks,
  loading,
  error,
  filter,
  setFilter,
  scope,
  setScope,
  selectedId,
  setSelectedId,
  onRefresh,
  onBack,
  workspaceName,
  cronJobs,
  onToggleCron,
}: {
  tasks: Task[]
  loading: boolean
  error: string | null
  filter: StatusFilter
  setFilter: (f: StatusFilter) => void
  scope: SourceScope
  setScope: (s: SourceScope) => void
  selectedId: string | null
  setSelectedId: (id: string) => void
  onRefresh: () => void
  onBack: () => void
  workspaceName?: string
  cronJobs?: CronJob[]
  onToggleCron?: (id: string) => void
}) {
  const counts = useMemo(() => ({
    all: tasks.length,
    dispatched: tasks.filter(t => t.status === 'dispatched').length,
    running: tasks.filter(t => t.status === 'running').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  }), [tasks])

  const visible = useMemo(() =>
    tasks.filter(t => filter === 'all' || t.status === filter),
  [filter, tasks])

  useEffect(() => {
    setSelectedId(visible[0]?.id ?? '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  return (
    <aside className="flex h-full min-w-0 flex-col overflow-hidden border-r border-[#313244] bg-[#181825]">
      {/* header */}
      <div className="shrink-0 border-b border-[#313244] px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#89b4fa] hover:bg-[#313244] transition-colors"
            >
              <ArrowLeft className="size-3" />
              Chat
            </button>
            <span className="text-[#45475a]">|</span>
            <Activity className="size-3.5 text-[#a6e3a1]" />
            <span className="text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Tasks</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex rounded bg-[#313244] p-0.5">
              {(['workspace', 'all'] as SourceScope[]).map(v => (
                <button
                  key={v}
                  onClick={() => setScope(v)}
                  className={cn(
                    'h-5 rounded px-1.5 font-mono text-[9px] font-bold uppercase transition-colors',
                    scope === v ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#7f849c] hover:text-[#cdd6f4]'
                  )}
                >
                  {v === 'workspace' ? 'Workspace' : 'All'}
                </button>
              ))}
            </div>
            <button onClick={onRefresh} className="rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]">
              <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            </button>
          </div>
        </div>
        <div className="truncate font-mono text-[10px] text-[#6c7086]">
          {scope === 'workspace' ? workspaceName || 'main' : 'all workspaces'}
        </div>
      </div>

      {/* filter chips */}
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-[#313244] px-3 py-2">
        {(['all', 'running', 'completed', 'failed'] as StatusFilter[]).map(v => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={cn(
              'h-6 rounded px-2 font-mono text-[10px] font-bold uppercase transition-colors',
              filter === v ? 'bg-[#45475a] text-[#cdd6f4]' : 'bg-[#313244]/60 text-[#7f849c] hover:text-[#cdd6f4]'
            )}
          >
            {v === 'all' ? 'All' : statusConfig[v].label}
            <span className="ml-1 text-[#6c7086]">{counts[v]}</span>
          </button>
        ))}
      </div>

      {/* task list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#7f849c]">
            <Loader2 className="size-3.5 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div className="mx-2 mt-2 flex items-center gap-2 rounded bg-[#f38ba8]/10 px-2 py-1.5 text-xs text-[#f38ba8]">
            <AlertTriangle className="size-3.5" /> {error}
          </div>
        ) : visible.length === 0 ? (
          <div className="py-12 text-center text-xs text-[#7f849c]">No tasks</div>
        ) : (
          <div className="space-y-0.5 p-1.5">
            {visible.map(task => (
              <button
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-[#313244]',
                  task.id === selectedId && 'bg-[#45475a]'
                )}
              >
                <StatusBadge status={task.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-[#cdd6f4]">
                    {task.description || shortText(task.prompt)}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[#6c7086]">
                  {task.duration_ms != null ? formatDuration(task.duration_ms) : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Cron Jobs */}
      {cronJobs && cronJobs.length > 0 && (
        <CronJobsSection jobs={cronJobs} onToggle={onToggleCron} />
      )}

      {/* summary footer */}
      <div className="shrink-0 border-t border-[#313244] px-3 py-2">
        <div className="flex items-center gap-3 font-mono text-[10px] text-[#6c7086]">
          <span>{counts.completed} done</span>
          <span>{counts.failed} fail</span>
          <span>{counts.running + counts.dispatched} active</span>
        </div>
      </div>
    </aside>
  )
}

/* ── Cron Jobs Section ──────────────────────────── */

function formatCronTime(ts?: string | null) {
  if (!ts) return 'never'
  try {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

function CronJobsSection({ jobs, onToggle }: { jobs: CronJob[]; onToggle?: (id: string) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="shrink-0 border-t border-[#313244]">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wider text-[#6c7086] hover:text-[#a6adc8]"
      >
        <Clock className="size-3" />
        Cron Jobs ({jobs.length})
        <span className="ml-auto text-[10px]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-0.5 px-1.5 pb-1.5">
          {jobs.map(job => (
            <div
              key={job.id}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[#313244]"
            >
              <button
                onClick={() => onToggle?.(job.id)}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded transition-colors',
                  job.enabled ? 'text-[#a6e3a1] hover:bg-[#a6e3a1]/20' : 'text-[#6c7086] hover:bg-[#6c7086]/20'
                )}
                title={job.enabled ? 'Pause' : 'Resume'}
              >
                {job.enabled ? <Play className="size-3" /> : <Pause className="size-3" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[#cdd6f4]">{job.name}</div>
                <div className="flex items-center gap-2 text-[10px] text-[#6c7086]">
                  <span className="font-mono">{job.schedule}</span>
                  <span>last: {formatCronTime(job.last_run_at)}</span>
                </div>
              </div>
              <span className={cn(
                'shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase',
                job.enabled ? 'bg-[#a6e3a1]/15 text-[#a6e3a1]' : 'bg-[#6c7086]/15 text-[#6c7086]'
              )}>
                {job.enabled ? 'on' : 'off'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

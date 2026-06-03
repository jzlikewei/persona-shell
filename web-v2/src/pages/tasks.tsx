import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal,
  X,
  XCircle,
} from 'lucide-react'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useApi } from '@/hooks/use-api'
import { useWebSocket } from '@/hooks/use-websocket'
import type { ShellOutletContext } from '@/layouts/root-layout'
import { cn } from '@/lib/utils'

/* ── types ────────────────────────────────────── */

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
type LogTypeFilter = 'all' | 'thinking' | 'tools' | 'results' | 'errors' | 'text' | 'system'

/* ── constants ────────────────────────────────── */

const statusConfig: Record<Task['status'], { label: string; badge: string; dot: string }> = {
  dispatched: { label: 'Dispatched', badge: 'bg-[#f9e2af]/15 text-[#f9e2af]', dot: 'bg-[#f9e2af]' },
  running:    { label: 'Running',    badge: 'bg-[#a6e3a1]/15 text-[#a6e3a1]', dot: 'bg-[#a6e3a1]' },
  completed:  { label: 'Completed',  badge: 'bg-[#89b4fa]/15 text-[#89b4fa]', dot: 'bg-[#89b4fa]' },
  failed:     { label: 'Failed',     badge: 'bg-[#f38ba8]/15 text-[#f38ba8]', dot: 'bg-[#f38ba8]' },
}

const logTypeFilters: { key: LogTypeFilter; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'tools',    label: 'Tools' },
  { key: 'results',  label: 'Results' },
  { key: 'errors',   label: 'Errors' },
  { key: 'text',     label: 'Text' },
  { key: 'system',   label: 'System' },
]

/* ── utils ────────────────────────────────────── */

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

function shortText(text: string, max = 80) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

function extraValue(task: Task, key: string) {
  const value = task.extra?.[key]
  return value == null ? '' : String(value)
}

function matchesLogType(entry: TaskLogEntry, filter: LogTypeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'tools') return entry.type === 'tool_use' || entry.type === 'tool_result'
  if (filter === 'results') return entry.type === 'tool_result'
  if (filter === 'errors') return entry.type === 'tool_result' && !!entry.meta?.is_error
  return entry.type === filter
}

function matchesSearch(entry: TaskLogEntry, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (entry.content.toLowerCase().includes(q)) return true
  if (entry.meta && JSON.stringify(entry.meta).toLowerCase().includes(q)) return true
  return false
}

/* ── small components ─────────────────────────── */

function StatusBadge({ status }: { status: Task['status'] }) {
  const cfg = statusConfig[status] ?? statusConfig.dispatched
  return (
    <span className={cn('inline-flex h-5 items-center gap-1.5 rounded px-2 font-mono text-[10px] font-bold uppercase tracking-[.04em]', cfg.badge)}>
      <span className={cn('size-1.5 rounded-full', cfg.dot, status === 'running' && 'animate-pulse')} />
      {cfg.label}
    </span>
  )
}

/* ── useTaskLogs hook ─────────────────────────── */

function useTaskLogs(taskId: string | null, taskStatus: Task['status'] | undefined) {
  const { get } = useApi()
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
    } catch {
      setLoading(false)
    }
  }, [get])

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

/* ── Left Panel: Task List ────────────────────── */

function TaskListPanel({
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
  directorLabel,
  workspaceName,
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
  directorLabel: string
  workspaceName: string
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
                  {v === 'workspace' ? 'WS' : 'All'}
                </button>
              ))}
            </div>
            <button onClick={onRefresh} className="rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]">
              <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            </button>
          </div>
        </div>
        <div className="truncate font-mono text-[10px] text-[#6c7086]">
          {scope === 'workspace' ? workspaceName || directorLabel : 'all workspaces'}
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

/* ── Center Panel: Live Logs ──────────────────── */

function LogEntry({ entry }: { entry: TaskLogEntry }) {
  const [expanded, setExpanded] = useState(false)

  if (entry.type === 'system') {
    return (
      <div className="rounded bg-[#181825]/40 px-3 py-1.5 font-mono text-[11px] text-[#6c7086]">
        <span className="mr-2 text-[#585b70]">{entry.line}</span>
        {entry.content}
      </div>
    )
  }

  if (entry.type === 'thinking') {
    return (
      <div className="rounded bg-[#cba6f7]/5 px-3 py-1.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-1.5 text-left font-mono text-[11px] text-[#cba6f7]"
        >
          <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
          <span className="font-bold">Thinking</span>
          <span className="ml-1 text-[#585b70]">#{entry.line}</span>
        </button>
        {expanded && (
          <pre className="mt-1.5 whitespace-pre-wrap break-words pl-5 font-mono text-[11px] italic leading-relaxed text-[#a6adc8]">
            {entry.content}
          </pre>
        )}
      </div>
    )
  }

  if (entry.type === 'tool_use') {
    const toolName = entry.content || 'unknown'
    const hasInput = entry.meta?.input != null
    return (
      <div className="rounded bg-[#89b4fa]/5 px-3 py-1.5">
        <button
          onClick={() => hasInput && setExpanded(!expanded)}
          className={cn(
            'flex w-full items-center gap-1.5 text-left font-mono text-[11px]',
            hasInput ? 'cursor-pointer' : 'cursor-default'
          )}
        >
          {hasInput && <ChevronRight className={cn('size-3 text-[#89b4fa] transition-transform', expanded && 'rotate-90')} />}
          {!hasInput && <span className="size-3" />}
          <span className="font-bold text-[#89b4fa]">▸ {toolName}</span>
          <span className="ml-1 text-[#585b70]">#{entry.line}</span>
        </button>
        {expanded && hasInput && (
          <pre className="mt-1.5 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded bg-[#181825]/60 p-2 pl-5 font-mono text-[11px] leading-relaxed text-[#bac2de]">
            {typeof entry.meta!.input === 'string' ? entry.meta!.input : JSON.stringify(entry.meta!.input, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  if (entry.type === 'tool_result') {
    const isError = !!entry.meta?.is_error
    const prefix = isError ? '✗' : '✓'
    const color = isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'
    const contentTruncated = entry.content.length > 300
    const displayContent = expanded ? entry.content : entry.content.slice(0, 300)

    return (
      <div className={cn('rounded px-3 py-1.5', isError ? 'bg-[#f38ba8]/5' : 'bg-[#a6e3a1]/5')}>
        <div className="flex items-start gap-1.5">
          <span className={cn('font-mono text-[11px] font-bold', color)}>{prefix}</span>
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#bac2de]">
            {displayContent}
            {contentTruncated && !expanded && '...'}
          </pre>
          <span className="shrink-0 font-mono text-[10px] text-[#585b70]">#{entry.line}</span>
        </div>
        {contentTruncated && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 pl-4 font-mono text-[10px] text-[#89b4fa] hover:underline"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </div>
    )
  }

  if (entry.type === 'result') {
    return (
      <div className="rounded bg-[#a6e3a1]/10 px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[11px] font-bold text-[#a6e3a1]">
          <span>● {entry.content}</span>
          <span className="text-[#585b70]">#{entry.line}</span>
        </div>
        {entry.meta && (
          <div className="mt-1 flex gap-3 font-mono text-[10px] text-[#6c7086]">
            {entry.meta.duration_ms != null && <span>{formatDuration(entry.meta.duration_ms as number)}</span>}
            {entry.meta.cost_usd != null && <span>${(entry.meta.cost_usd as number).toFixed(4)}</span>}
            {entry.meta.num_turns != null && <span>{entry.meta.num_turns as number} turns</span>}
          </div>
        )}
      </div>
    )
  }

  // text
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-[#bac2de]">
          <MarkdownRenderer content={entry.content} />
        </div>
        <span className="shrink-0 pt-0.5 font-mono text-[10px] text-[#585b70]">#{entry.line}</span>
      </div>
    </div>
  )
}

function LogsPanel({
  task,
  logs,
  totalLines,
  loading,
}: {
  task: Task | null
  logs: TaskLogEntry[]
  totalLines: number
  loading: boolean
}) {
  const [logFilter, setLogFilter] = useState<LogTypeFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const logsEndRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolled = useRef(false)

  useEffect(() => {
    setLogFilter('all')
    setSearchQuery('')
    userScrolled.current = false
  }, [task?.id])

  const filteredLogs = useMemo(() =>
    logs.filter(e => matchesLogType(e, logFilter) && matchesSearch(e, searchQuery)),
  [logs, logFilter, searchQuery])

  const typeCounts = useMemo(() => ({
    all: logs.length,
    thinking: logs.filter(e => e.type === 'thinking').length,
    tools: logs.filter(e => e.type === 'tool_use' || e.type === 'tool_result').length,
    results: logs.filter(e => e.type === 'tool_result').length,
    errors: logs.filter(e => e.type === 'tool_result' && !!e.meta?.is_error).length,
    text: logs.filter(e => e.type === 'text').length,
    system: logs.filter(e => e.type === 'system').length,
  }), [logs])

  useEffect(() => {
    if (!userScrolled.current && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [filteredLogs.length])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    userScrolled.current = !atBottom
  }, [])

  const handleExport = useCallback(() => {
    const data = filteredLogs.map(e => JSON.stringify(e)).join('\n')
    const blob = new Blob([data], { type: 'application/x-ndjson' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `task-${task?.id ?? 'logs'}.ndjson`
    a.click()
    URL.revokeObjectURL(url)
  }, [filteredLogs, task?.id])

  if (!task) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-[#1e1e2e] text-sm text-[#7f849c]">
        <Terminal className="mb-2 size-8 text-[#45475a]" />
        Select a task to view logs
      </div>
    )
  }

  const isLive = task.status === 'running' || task.status === 'dispatched'

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#1e1e2e]">
      {/* header */}
      <div className="shrink-0 border-b border-[#45475a] px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-bold text-[#cdd6f4]">Logs</span>
            <span className="font-mono text-xs text-[#a6adc8]">{task.id}</span>
          </div>
          <div className="flex items-center gap-2">
            {isLive && (
              <span className="flex items-center gap-1.5 font-mono text-[10px] font-bold text-[#a6e3a1]">
                <span className="size-1.5 animate-pulse rounded-full bg-[#a6e3a1]" />
                Live
              </span>
            )}
            <span className="font-mono text-[10px] text-[#6c7086]">{task.status === 'running' ? 'executor' : task.status}</span>
          </div>
        </div>

        {/* log type filter chips */}
        <div className="flex flex-wrap items-center gap-1">
          {logTypeFilters.map(({ key, label }) => {
            const count = typeCounts[key]
            if (key !== 'all' && count === 0) return null
            return (
              <button
                key={key}
                onClick={() => setLogFilter(key)}
                className={cn(
                  'h-6 rounded px-2 font-mono text-[10px] font-bold transition-colors',
                  logFilter === key
                    ? 'bg-[#89b4fa]/20 text-[#89b4fa]'
                    : 'bg-[#313244]/60 text-[#7f849c] hover:text-[#cdd6f4]'
                )}
              >
                {label} <span className="text-[#6c7086]">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* search + export bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[#45475a] px-3 py-1.5">
        <Search className="size-3.5 text-[#6c7086]" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search logs"
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[#cdd6f4] placeholder-[#585b70] outline-none"
        />
        <button onClick={handleExport} className="rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]">
          <Download className="size-3.5" />
        </button>
        <span className="font-mono text-[10px] text-[#6c7086]">{filteredLogs.length}/{totalLines}</span>
      </div>

      {/* log entries */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#7f849c]">
            <Loader2 className="size-3.5 animate-spin" /> Loading logs...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-xs text-[#7f849c]">
            <Terminal className="mb-2 size-6 text-[#45475a]" />
            {logs.length === 0 ? 'No logs yet' : 'No matching entries'}
          </div>
        ) : (
          <div className="space-y-0.5 p-2">
            {filteredLogs.map(entry => (
              <LogEntry key={`${entry.line}-${entry.type}`} entry={entry} />
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Right Panel: Result + Prompt (floating overlay) ── */

function ResultPanel({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { get, post } = useApi()
  const [output, setOutput] = useState<TaskOutput | null>(null)
  const [loadingOutput, setLoadingOutput] = useState(false)

  const STORAGE_KEY = 'persona-shell:v2:tasks-right-width'
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? Number(saved) : 400
  })
  const dragging = useRef(false)
  const lastX = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastX.current = e.clientX
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = lastX.current - ev.clientX
      lastX.current = ev.clientX
      setWidth(prev => {
        const maxW = Math.floor(window.innerWidth * 0.8)
        const next = Math.max(280, Math.min(maxW, prev + delta))
        localStorage.setItem(STORAGE_KEY, String(next))
        return next
      })
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
  }, [])

  useEffect(() => {
    setOutput(null)
    if (!task) return
    if (task.status !== 'completed' && task.status !== 'failed') return
    if (!task.result_file) return
    setLoadingOutput(true)
    get<TaskOutput>(`/api/tasks/${task.id}/output`)
      .then(setOutput)
      .catch(err => setOutput({ error: err instanceof Error ? err.message : String(err) }))
      .finally(() => setLoadingOutput(false))
  }, [task?.id, task?.status, task?.result_file, get])

  const handleAction = useCallback(async (action: 'cancel' | 'retry') => {
    if (!task) return
    try {
      await post(`/api/tasks/${task.id}/${action}`)
    } catch (err) {
      console.error(`Failed to ${action} task:`, err)
    }
  }, [task, post])

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
  }, [])

  if (!task) return null

  const model = extraValue(task, 'model')
  const projectDir = extraValue(task, 'project_dir')
  const canCancel = task.status === 'running' || task.status === 'dispatched'
  const canRetry = task.status === 'failed'
  const hasArtifact = !!task.result_file
  const hasOutput = output?.content != null

  return (
    <div
      className="fixed top-0 right-0 z-50 flex h-full"
      style={{ width: width + 8 }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center hover:bg-[#89b4fa]/30 active:bg-[#89b4fa]/40 transition-colors"
      >
        <div className="h-8 w-0.5 rounded-full bg-[#6c7086] group-hover:bg-[#89b4fa] transition-colors" />
      </div>

      {/* Panel */}
      <div className="flex flex-1 flex-col overflow-hidden border-l border-[#45475a] bg-[#181825] shadow-[-4px_0_24px_rgba(0,0,0,.4)]">
        {/* header */}
        <div className="shrink-0 border-b border-[#313244] px-3 py-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Result</span>
            <div className="flex items-center gap-2">
              <StatusBadge status={task.status} />
              <button onClick={onClose} className="rounded p-0.5 text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]">
                <X className="size-3.5" />
              </button>
            </div>
          </div>

          {/* action buttons */}
          <div className="flex flex-wrap gap-1">
            {task.result_file && (
              <button
                onClick={() => handleCopy(task.result_file!)}
                className="inline-flex h-6 items-center gap-1 rounded bg-[#89b4fa]/15 px-2 font-mono text-[9px] font-bold uppercase text-[#89b4fa] hover:bg-[#89b4fa]/25"
              >
                <Copy className="size-2.5" /> Copy Path
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => handleAction('cancel')}
                className="inline-flex h-6 items-center gap-1 rounded bg-[#f38ba8]/15 px-2 font-mono text-[9px] font-bold uppercase text-[#f38ba8] hover:bg-[#f38ba8]/25"
              >
                <XCircle className="size-2.5" /> Cancel
              </button>
            )}
            {canRetry && (
              <button
                onClick={() => handleAction('retry')}
                className="inline-flex h-6 items-center gap-1 rounded bg-[#89b4fa]/15 px-2 font-mono text-[9px] font-bold uppercase text-[#89b4fa] hover:bg-[#89b4fa]/25"
              >
                <RotateCcw className="size-2.5" /> Retry
              </button>
            )}
          </div>
        </div>

        {/* scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* prompt / input params — shown first */}
          <div className="border-b border-[#313244] px-3 py-2">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Input / Prompt</div>
            <pre className="whitespace-pre-wrap break-words rounded bg-[#1e1e2e] p-2 font-mono text-[11px] leading-relaxed text-[#bac2de]">
              {task.prompt}
            </pre>
          </div>

          {/* task error */}
          {task.error && (
            <div className="border-b border-[#313244] px-3 py-2">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#f38ba8]">Error</div>
              <div className="rounded bg-[#f38ba8]/10 px-2 py-1.5 font-mono text-[11px] text-[#f38ba8]">
                {task.error}
              </div>
            </div>
          )}

          {/* completion evidence */}
          {(task.status === 'completed' || task.status === 'failed') && (
            <div className="border-b border-[#313244] px-3 py-2">
              <div className="mb-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#6c7086]">Completion Evidence</div>
              <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
                <div>
                  <div className="text-[9px] text-[#585b70]">Artifact</div>
                  <div className={hasArtifact ? 'text-[#a6e3a1]' : 'text-[#6c7086]'}>{hasArtifact ? 'ready' : 'none'}</div>
                </div>
                <div>
                  <div className="text-[9px] text-[#585b70]">Output</div>
                  <div className={hasOutput ? 'text-[#a6e3a1]' : loadingOutput ? 'text-[#f9e2af]' : 'text-[#6c7086]'}>
                    {hasOutput ? 'loaded' : loadingOutput ? 'loading' : 'none'}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-[#585b70]">Sent</div>
                  <div className="text-[#6c7086]">not sent</div>
                </div>
              </div>
            </div>
          )}

          {/* output */}
          {output && !output.error && output.content && (
            <div className="border-b border-[#313244] px-3 py-2">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Output</div>
              <div className="text-[12px] leading-relaxed text-[#bac2de]">
                <MarkdownRenderer content={output.content} />
              </div>
            </div>
          )}
          {output?.error && (
            <div className="border-b border-[#313244] px-3 py-2">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Output</div>
              <div className="rounded bg-[#181825]/60 p-2 font-mono text-[11px] text-[#6c7086]">{output.error}</div>
            </div>
          )}

          {/* result file path */}
          {task.result_file && (
            <div className="border-b border-[#313244] px-3 py-2">
              <div className="mb-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#6c7086]">Result File</div>
              <div className="truncate font-mono text-[10px] text-[#a6adc8]">{task.result_file}</div>
            </div>
          )}

          {/* meta info */}
          <div className="px-3 py-2">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Meta</div>
            <div className="space-y-1 font-mono text-[10px]">
              <div className="flex justify-between"><span className="text-[#6c7086]">ID</span><span className="text-[#a6adc8]">{task.id}</span></div>
              <div className="flex justify-between"><span className="text-[#6c7086]">Role</span><span className="text-[#a6adc8]">{task.role}</span></div>
              {task.agent && <div className="flex justify-between"><span className="text-[#6c7086]">Agent</span><span className="text-[#a6adc8]">{task.agent}</span></div>}
              {model && <div className="flex justify-between"><span className="text-[#6c7086]">Model</span><span className="text-[#a6adc8]">{model}</span></div>}
              {projectDir && <div className="flex justify-between"><span className="text-[#6c7086]">Project Dir</span><span className="truncate ml-4 text-[#a6adc8]">{projectDir}</span></div>}
              <div className="flex justify-between"><span className="text-[#6c7086]">Source</span><span className="text-[#a6adc8]">{task.source_director || 'main'}</span></div>
              <div className="flex justify-between"><span className="text-[#6c7086]">Created</span><span className="text-[#a6adc8]">{formatTime(task.created_at)}</span></div>
              {task.duration_ms != null && (
                <div className="flex justify-between"><span className="text-[#6c7086]">Duration</span><span className="text-[#a6adc8]">{formatDuration(task.duration_ms)}</span></div>
              )}
              {task.cost_usd != null && (
                <div className="flex justify-between"><span className="text-[#6c7086]">Cost</span><span className="text-[#a6adc8]">${task.cost_usd.toFixed(4)}</span></div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Drag Handle ──────────────────────────────── */

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
  const { activeWorkspace, directorLabel } = useOutletContext<ShellOutletContext>()
  const navigate = useNavigate()
  const { get } = useApi()
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
  }, [directorLabel])

  const fetchTasks = useCallback((silent = false) => {
    const params: Record<string, string> = { limit: '200' }
    if (scope === 'workspace') params.source_director = directorLabel || 'main'
    if (!silent) { setLoading(true); setError(null) }
    get<Task[]>('/api/tasks', params)
      .then(list => {
        setTasks(Array.isArray(list) ? list : [])
      })
      .catch(err => { if (!silent) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!silent) setLoading(false) })
  }, [directorLabel, get, scope])

  useEffect(() => { fetchTasks() }, [fetchTasks])

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
          directorLabel={directorLabel}
          workspaceName={activeWorkspace?.name ?? ''}
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

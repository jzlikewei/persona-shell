import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Copy,
  Download,
  Loader2,
  RotateCcw,
  Search,
  Terminal,
  X,
  XCircle,
} from 'lucide-react'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useApi } from '@/hooks/use-api'
import { cn } from '@/lib/utils'
import type { Task, TaskOutput } from './index'
import type { TaskLogEntry } from '@/hooks/use-task-logs'
import { formatDuration, formatTime, StatusBadge } from './task-list'

/* ── types & constants ────────────────────────── */

export type LogTypeFilter = 'all' | 'thinking' | 'tools' | 'results' | 'errors' | 'text' | 'system'

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

/* ── LogEntry ─────────────────────────────────── */

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

/* ── LogsPanel ────────────────────────────────── */

export function LogsPanel({
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

/* ── ResultPanel ──────────────────────────────── */

export function ResultPanel({ task, onClose }: { task: Task | null; onClose: () => void }) {
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
    setConfirmAction(null)
    setActionPending(null)
    if (!task) return
    if (task.status !== 'completed' && task.status !== 'failed') return
    if (!task.result_file) return
    setLoadingOutput(true)
    get<TaskOutput>(`/api/tasks/${task.id}/output`)
      .then(setOutput)
      .catch(err => setOutput({ error: err instanceof Error ? err.message : String(err) }))
      .finally(() => setLoadingOutput(false))
  }, [task?.id, task?.status, task?.result_file, get])

  const [actionPending, setActionPending] = useState<'cancel' | 'retry' | null>(null)
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'retry' | null>(null)

  const handleAction = useCallback(async (action: 'cancel' | 'retry') => {
    if (!task) return
    setActionPending(action)
    try {
      await post(`/api/tasks/${task.id}/${action}`)
    } catch (err) {
      console.error(`Failed to ${action} task:`, err)
    } finally {
      setActionPending(null)
      setConfirmAction(null)
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
              confirmAction === 'cancel' ? (
                <span className="inline-flex items-center gap-1.5">
                  <button
                    onClick={() => handleAction('cancel')}
                    disabled={actionPending === 'cancel'}
                    className="inline-flex h-6 items-center gap-1 rounded bg-[#f38ba8]/30 px-2 font-mono text-[9px] font-bold uppercase text-[#f38ba8] hover:bg-[#f38ba8]/40 disabled:opacity-50"
                  >
                    {actionPending === 'cancel' ? <Loader2 className="size-2.5 animate-spin" /> : <XCircle className="size-2.5" />} Confirm
                  </button>
                  <button
                    onClick={() => setConfirmAction(null)}
                    className="inline-flex h-6 items-center rounded px-1.5 font-mono text-[9px] text-[#6c7086] hover:text-[#a6adc8]"
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmAction('cancel')}
                  className="inline-flex h-6 items-center gap-1 rounded bg-[#f38ba8]/15 px-2 font-mono text-[9px] font-bold uppercase text-[#f38ba8] hover:bg-[#f38ba8]/25"
                >
                  <XCircle className="size-2.5" /> Cancel
                </button>
              )
            )}
            {canRetry && (
              <button
                onClick={() => handleAction('retry')}
                disabled={actionPending === 'retry'}
                className="inline-flex h-6 items-center gap-1 rounded bg-[#89b4fa]/15 px-2 font-mono text-[9px] font-bold uppercase text-[#89b4fa] hover:bg-[#89b4fa]/25 disabled:opacity-50"
              >
                {actionPending === 'retry' ? <Loader2 className="size-2.5 animate-spin" /> : <RotateCcw className="size-2.5" />} Retry
              </button>
            )}
          </div>
        </div>

        {/* scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* prompt / input params */}
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
              <div className="flex justify-between"><span className="text-[#6c7086]">Workspace</span><span className="text-[#a6adc8]">{task.workspace || 'main'}</span></div>
              {task.source_session_id && <div className="flex justify-between"><span className="text-[#6c7086]">Session</span><span className="ml-4 truncate text-[#a6adc8]">{task.source_session_id}</span></div>}
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

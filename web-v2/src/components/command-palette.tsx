import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  Brush,
  Eraser,
  FileCode2,
  ListTodo,
  MessageSquare,
  RotateCcw,
  Search,
  Square,
} from 'lucide-react'
import { useDirectorActions } from '@/hooks/use-director-actions'
import { setOpenCommandPaletteHandler } from '@/lib/shortcut-registry'
import { useToast } from '@/components/toast'
import { cn } from '@/lib/utils'

interface PaletteAction {
  id: string
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  keywords: string[]
  run: () => void
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { toast } = useToast()
  const { flush, restart, interrupt, clear } = useDirectorActions()

  const actions = useMemo<PaletteAction[]>(
    () => [
      { id: 'flush', label: 'Flush Director', hint: '刷新上下文', icon: Brush, keywords: ['flush', 'clear-context', '刷新', '上下文'], run: () => flush() },
      { id: 'restart', label: 'Restart Director', hint: '重启 Director 进程', icon: RotateCcw, keywords: ['restart', '重启'], run: () => restart() },
      { id: 'interrupt', label: 'Interrupt', hint: '中断当前 turn', icon: Square, keywords: ['interrupt', 'stop', 'cancel', '中断', '停止'], run: () => interrupt() },
      { id: 'clear', label: 'Clear context', hint: '清空上下文', icon: Eraser, keywords: ['clear', 'context', '清空'], run: () => clear() },
      { id: 'focus-chat', label: 'Go to Chat', icon: MessageSquare, keywords: ['chat', '聊天', '主页'], run: () => navigate('/') },
      { id: 'focus-tasks', label: 'Go to Tasks', icon: ListTodo, keywords: ['tasks', '任务'], run: () => navigate('/tasks') },
      { id: 'focus-files', label: 'Go to Files', icon: FileCode2, keywords: ['files', '文件'], run: () => navigate('/files') },
      {
        id: 'help',
        label: '帮助(更多快捷键)',
        icon: Search,
        keywords: ['help', 'shortcut', '帮助', '快捷键'],
        run: () => toast({ title: '快捷键', description: 'Mod+K 调出命令面板', tone: 'info' }),
      },
    ],
    [flush, restart, interrupt, clear, navigate, toast]
  )

  const filtered = useMemo(() => {
    if (!query.trim()) return actions
    const q = query.toLowerCase()
    return actions.filter(
      a =>
        a.label.toLowerCase().includes(q) ||
        (a.hint?.toLowerCase().includes(q) ?? false) ||
        a.keywords.some(k => k.toLowerCase().includes(q))
    )
  }, [query, actions])

  // 注册 mod+k 全局打开
  useEffect(() => {
    setOpenCommandPaletteHandler(() => setOpen(true))
    return () => setOpenCommandPaletteHandler(null)
  }, [])

  // 打开时:重置 query、focus input
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // query 变化时:active 跳回 0
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  const close = useCallback(() => setOpen(false), [])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const action = filtered[activeIndex]
      if (action) {
        action.run()
        close()
      }
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[150] flex items-start justify-center bg-black/50 pt-[15vh] backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-[600px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-card shadow-2xl"
        onClick={e => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索动作..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div className="max-h-[400px] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">没有匹配的动作</div>
          ) : (
            filtered.map((a, i) => {
              const Icon = a.icon
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    a.run()
                    close()
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors',
                    i === activeIndex ? 'bg-accent text-accent-foreground' : 'text-card-foreground'
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{a.label}</span>
                  {a.hint && <span className="text-xs text-muted-foreground">{a.hint}</span>}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

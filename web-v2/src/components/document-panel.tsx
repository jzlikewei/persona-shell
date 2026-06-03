import { useState, useEffect, useRef, useCallback } from 'react'
import { X, FileText, Image } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useApi } from '@/hooks/use-api'

interface DocumentPanelProps {
  filePath: string | null
  onClose: () => void
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(path)
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

function usePanelContent(filePath: string) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { get } = useApi()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)

    get<{ content: string }>('/api/files/read', { path: filePath })
      .then(data => {
        if (!cancelled) setContent(data.content ?? String(data))
      })
      .catch(err => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [filePath, get])

  return { content, loading, error }
}

function PanelContent({ filePath, content, loading, error }: {
  filePath: string
  content: string | null
  loading: boolean
  error: string | null
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-[#7f849c]">
        Loading...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-[#f38ba8]">
        Failed to load file: {error}
      </div>
    )
  }

  if (isImagePath(filePath)) {
    return (
      <div className="p-4 flex items-center justify-center">
        <img
          src={`/api/files/content?path=${encodeURIComponent(filePath)}&raw=1`}
          alt={filePath}
          className="max-w-full rounded"
        />
      </div>
    )
  }

  if (isMarkdownPath(filePath)) {
    return (
      <div className="p-4">
        <MarkdownRenderer
          content={content ?? ''}
          className="prose prose-sm prose-invert max-w-none text-[#bac2de] [&_a]:text-[#89b4fa] [&_code]:rounded [&_code]:bg-[#45475a] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#fab387] [&_ol]:my-1 [&_p]:my-1.5 [&_pre]:my-2 [&_ul]:my-1"
        />
      </div>
    )
  }

  return (
    <pre className="p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono text-[#bac2de]">
      {content}
    </pre>
  )
}

const STORAGE_KEY = 'persona-shell:v2:doc-panel-width'

export function DocumentPanel({ filePath, onClose }: DocumentPanelProps) {
  if (!filePath) return null

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? Number(saved) : 420
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

  const { content, loading, error } = usePanelContent(filePath)
  const fileName = filePath.split('/').pop() ?? filePath
  const icon = isImagePath(filePath) ? Image : FileText

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
      <div className="flex flex-1 flex-col overflow-hidden border-l border-[#45475a] bg-[#1e1e2e] shadow-[-4px_0_24px_rgba(0,0,0,.4)]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#45475a] shrink-0">
          {(() => { const Icon = icon; return <Icon className="h-4 w-4 text-[#7f849c] shrink-0" /> })()}
          <span className="text-sm font-medium truncate flex-1 text-[#cdd6f4]" title={filePath}>{fileName}</span>
          <Button variant="ghost" size="icon" onClick={onClose} className="shrink-0 h-7 w-7 text-[#7f849c] hover:text-[#cdd6f4]">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Path bar */}
        <div className="px-4 py-1.5 text-[11px] text-[#7f849c] bg-[#181825] border-b border-[#45475a] font-mono truncate">
          {filePath}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <PanelContent filePath={filePath} content={content} loading={loading} error={error} />
        </div>
      </div>
    </div>
  )
}

const FILE_PATH_REGEX = /(?:^|\s)((?:\/|\.\/|~\/)[^\s"'`,;:!?\])}]+\.\w{1,10})/g

export function extractFilePaths(text: string): string[] {
  const matches: string[] = []
  let match
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    matches.push(match[1])
  }
  return matches
}

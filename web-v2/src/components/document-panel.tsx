import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { X, FileText, Image } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent } from '@/components/ui/sheet'
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

function PanelContent({ filePath }: { filePath: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { get } = useApi()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)

    get<{ content: string }>('/api/files/content', { path: filePath })
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">
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
      <div className="p-4 prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content ?? ''}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <pre className="p-4 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground">
      {content}
    </pre>
  )
}

export function DocumentPanel({ filePath, onClose }: DocumentPanelProps) {
  if (!filePath) return null

  const fileName = filePath.split('/').pop() ?? filePath
  const icon = isImagePath(filePath) ? Image : FileText

  const header = (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
      {(() => { const Icon = icon; return <Icon className="h-4 w-4 text-muted-foreground shrink-0" /> })()}
      <span className="text-sm font-medium truncate flex-1" title={filePath}>{fileName}</span>
      <Button variant="ghost" size="icon" onClick={onClose} className="shrink-0 h-7 w-7">
        <X className="h-4 w-4" />
      </Button>
    </div>
  )

  const pathBar = (
    <div className="px-4 py-1.5 text-[11px] text-muted-foreground bg-muted/30 border-b border-border font-mono truncate">
      {filePath}
    </div>
  )

  return (
    <>
      {/* Desktop: side panel */}
      <div className="hidden md:flex flex-col w-[420px] border-l border-border bg-background shrink-0">
        {header}
        {pathBar}
        <ScrollArea className="flex-1">
          <PanelContent filePath={filePath} />
        </ScrollArea>
      </div>

      {/* Mobile: overlay sheet */}
      <Sheet open={true} onOpenChange={(open) => { if (!open) onClose() }}>
        <SheetContent side="right" className="p-0 w-full sm:max-w-lg" showCloseButton={false}>
          {header}
          {pathBar}
          <ScrollArea className="flex-1">
            <PanelContent filePath={filePath} />
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
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

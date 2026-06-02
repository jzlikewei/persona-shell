import { useState, useEffect, useCallback } from 'react'
import { FileText, Image, File, Download, Loader2, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useApi } from '@/hooks/use-api'
import { config } from '@/lib/config'
import { cn } from '@/lib/utils'

interface FileEntry {
  name: string
  path: string
  size: number
  modified: string
  type: string
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(path)
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path)
}

function getFileIcon(file: FileEntry) {
  if (isImagePath(file.name)) return Image
  if (isMarkdownPath(file.name)) return FileText
  return File
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function groupByDate(files: FileEntry[]): Map<string, FileEntry[]> {
  const groups = new Map<string, FileEntry[]>()
  for (const f of files) {
    const dateKey = f.path.match(/outbox\/([\d-]+)\//)?.[1]
      ?? new Date(f.modified).toISOString().split('T')[0]
    if (!groups.has(dateKey)) groups.set(dateKey, [])
    groups.get(dateKey)!.push(f)
  }
  return new Map([...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])))
}

function FilePreview({ filePath }: { filePath: string }) {
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
      .then(data => { if (!cancelled) setContent(data.content ?? String(data)) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [filePath, get])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
      </div>
    )
  }

  if (error) {
    return <div className="p-4 text-sm text-destructive">Failed to load: {error}</div>
  }

  if (isImagePath(filePath)) {
    return (
      <div className="p-4 flex items-center justify-center">
        <img
          src={`${config.apiBase}/api/files/content?path=${encodeURIComponent(filePath)}&raw=1`}
          alt={filePath.split('/').pop()}
          className="max-w-full max-h-[60vh] rounded"
        />
      </div>
    )
  }

  if (isMarkdownPath(filePath)) {
    return (
      <div className="p-4">
        <MarkdownRenderer content={content ?? ''} />
      </div>
    )
  }

  return (
    <pre className="p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-foreground">
      {content}
    </pre>
  )
}

export function FilesPage() {
  const { get } = useApi()
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const fetchFiles = useCallback(() => {
    get<FileEntry[]>('/api/files')
      .then(setFiles)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [get])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles])

  const grouped = groupByDate(files)
  const selectedFile = files.find(f => f.path === selectedPath)

  const downloadUrl = (path: string) => {
    const token = localStorage.getItem('auth_token') || ''
    return `${config.apiBase}/api/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`
  }

  return (
    <div className="flex h-full">
      {/* File list */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-border shrink-0">
          <h1 className="text-lg font-semibold">Files</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {files.length} files in outbox
          </p>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6 max-w-3xl">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading files...
              </div>
            ) : files.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" />
                No files found.
              </div>
            ) : (
              [...grouped.entries()].map(([date, group]) => (
                <div key={date}>
                  <h2 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">{date}</h2>
                  <div className="space-y-1">
                    {group.map(file => {
                      const Icon = getFileIcon(file)
                      return (
                        <div
                          key={file.path}
                          className={cn(
                            'flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors',
                            selectedPath === file.path
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-accent/50'
                          )}
                          onClick={() => setSelectedPath(file.path === selectedPath ? null : file.path)}
                        >
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm truncate">{file.name}</p>
                            <p className="text-[11px] text-muted-foreground">{formatSize(file.size)}</p>
                          </div>
                          <a
                            href={downloadUrl(file.path)}
                            download
                            onClick={e => e.stopPropagation()}
                            className="shrink-0 p-1 rounded hover:bg-muted transition-colors"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5 text-muted-foreground" />
                          </a>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Preview panel */}
      {selectedFile && (
        <div className="hidden md:flex flex-col w-[480px] border-l border-border bg-background shrink-0">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
            {(() => { const Icon = getFileIcon(selectedFile); return <Icon className="h-4 w-4 text-muted-foreground" /> })()}
            <span className="text-sm font-medium truncate flex-1">{selectedFile.name}</span>
            <a
              href={downloadUrl(selectedFile.path)}
              download
              className="shrink-0"
            >
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Download className="h-4 w-4" />
              </Button>
            </a>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelectedPath(null)}>
              &times;
            </Button>
          </div>
          <div className="px-4 py-1.5 text-[11px] text-muted-foreground bg-muted/30 border-b border-border font-mono truncate">
            {selectedFile.path}
          </div>
          <ScrollArea className="flex-1">
            <FilePreview filePath={selectedFile.path} />
          </ScrollArea>
        </div>
      )}
    </div>
  )
}

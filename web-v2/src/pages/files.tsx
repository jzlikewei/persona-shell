import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router'
import {
  ChevronRight,
  File,
  FileText,
  Folder,
  Loader2,
  FolderOpen,
} from 'lucide-react'
import { useApi } from '@/hooks/use-api'
import type { ShellOutletContext } from '@/layouts/root-layout'
import { cn } from '@/lib/utils'

interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: TreeEntry[]
}

interface TreeResponse {
  root: string
  dir?: string
  tree: TreeEntry[]
}

const FILES_CACHE_TTL_MS = 15_000
const dirCache = new Map<string, { at: number; data: TreeResponse }>()
const fileCache = new Map<string, { at: number; content: string }>()

function isMarkdown(name: string) {
  return /\.(md|mdx|markdown)$/i.test(name)
}

function formatSize(bytes?: number) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileIcon({ name }: { name: string }) {
  if (isMarkdown(name)) return <FileText className="size-3.5 text-[#89b4fa]" />
  return <File className="size-3.5 text-[#7f849c]" />
}

function TreeNode({
  entry,
  depth,
  selectedPath,
  onSelect,
  onLoadChildren,
  loadingDirs,
}: {
  entry: TreeEntry
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
  onLoadChildren: (entry: TreeEntry) => void
  loadingDirs: Set<string>
}) {
  const [open, setOpen] = useState(false)

  if (entry.type === 'dir') {
    const loading = loadingDirs.has(entry.path)
    const hasLoadedChildren = Array.isArray(entry.children)
    return (
      <div>
        <button
          onClick={() => {
            const nextOpen = !open
            setOpen(nextOpen)
            if (nextOpen && !hasLoadedChildren) onLoadChildren(entry)
          }}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-[#313244] transition-colors"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin text-[#6c7086]" />
          ) : (
            <ChevronRight className={cn('size-3 text-[#6c7086] transition-transform', open && 'rotate-90')} />
          )}
          {open ? <FolderOpen className="size-3.5 text-[#f9e2af]" /> : <Folder className="size-3.5 text-[#f9e2af]" />}
          <span className="truncate text-[12px] font-medium text-[#cdd6f4]">{entry.name}</span>
        </button>
        {open && entry.children?.map(child => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onLoadChildren={onLoadChildren}
            loadingDirs={loadingDirs}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelect(entry.path)}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors',
        entry.path === selectedPath ? 'bg-[#45475a]' : 'hover:bg-[#313244]'
      )}
      style={{ paddingLeft: depth * 12 + 18 }}
    >
      <FileIcon name={entry.name} />
      <span className="min-w-0 flex-1 truncate text-[12px] text-[#bac2de]">{entry.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-[#585b70]">{formatSize(entry.size)}</span>
    </button>
  )
}

function FileContent({ path, root }: { path: string; root: string }) {
  const { get } = useApi()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const cached = fileCache.get(path)
    if (cached && Date.now() - cached.at < FILES_CACHE_TTL_MS) {
      setContent(cached.content)
      setLoading(false)
      setError(null)
      return () => { cancelled = true }
    }
    setLoading(true)
    setError(null)
    setContent(null)
    get<{ content: string }>('/api/files/read', { root, path })
      .then(data => {
        fileCache.set(path, { at: Date.now(), content: data.content })
        if (!cancelled) setContent(data.content)
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path, root, get])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#7f849c]">
        <Loader2 className="size-3.5 animate-spin" /> Loading...
      </div>
    )
  }

  if (error) {
    return <div className="p-4 text-xs text-[#f38ba8]">{error}</div>
  }

  const lines = (content ?? '').split('\n')

  return (
    <div className="overflow-auto font-mono text-[12px] leading-relaxed">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="hover:bg-[#313244]/40">
              <td className="select-none border-r border-[#313244] px-3 py-0 text-right align-top text-[#585b70]">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all px-3 py-0 text-[#cdd6f4]">{line || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function FilesPage() {
  const { activeProject, activeWorkspace } = useOutletContext<ShellOutletContext>()
  const { get } = useApi()
  const [tree, setTree] = useState<TreeEntry[]>([])
  const [root, setRoot] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const projectPath = activeWorkspace?.cwd ?? activeProject?.path

  const fetchDir = useCallback(async (dir: string): Promise<TreeResponse> => {
    if (!projectPath) throw new Error('Project path is not set')
    const cacheKey = `${projectPath}\0${dir}`
    const cached = dirCache.get(cacheKey)
    if (cached && Date.now() - cached.at < FILES_CACHE_TTL_MS) return cached.data
    const data = await get<TreeResponse>('/api/files/tree', { root: projectPath, dir, depth: '0' })
    dirCache.set(cacheKey, { at: Date.now(), data })
    return data
  }, [get, projectPath])

  const fetchTree = useCallback(() => {
    if (!projectPath) return undefined
    setLoading(true)
    return fetchDir(projectPath)
      .then(data => {
        setRoot(data.root)
        setTree(data.tree)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [fetchDir, projectPath])

  const replaceNodeChildren = useCallback((entries: TreeEntry[], path: string, children: TreeEntry[]): TreeEntry[] =>
    entries.map(entry => {
      if (entry.path === path) return { ...entry, children }
      if (entry.children) return { ...entry, children: replaceNodeChildren(entry.children, path, children) }
      return entry
    }), [])

  const loadChildren = useCallback((entry: TreeEntry) => {
    if (!projectPath || entry.type !== 'dir' || loadingDirs.has(entry.path)) return
    setLoadingDirs(prev => new Set(prev).add(entry.path))
    fetchDir(entry.path)
      .then(data => setTree(prev => replaceNodeChildren(prev, entry.path, data.tree)))
      .catch(() => setTree(prev => replaceNodeChildren(prev, entry.path, [])))
      .finally(() => setLoadingDirs(prev => {
        const next = new Set(prev)
        next.delete(entry.path)
        return next
      }))
  }, [fetchDir, loadingDirs, projectPath, replaceNodeChildren])

  useEffect(() => {
    setSelectedPath(null)
    setLoadingDirs(new Set())
    fetchTree()
  }, [fetchTree])

  const fileName = selectedPath?.split('/').pop() ?? ''

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* file tree */}
      <aside className="flex w-[280px] shrink-0 flex-col overflow-hidden border-r border-[#313244] bg-[#181825]">
        <div className="shrink-0 border-b border-[#313244] px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Project Files</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[#6c7086]">{root.replace(/^\/Users\/[^/]+/, '~')}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-[#7f849c]">
              <Loader2 className="size-3.5 animate-spin" /> Loading...
            </div>
          ) : tree.length === 0 ? (
            <div className="py-12 text-center text-xs text-[#7f849c]">No files</div>
          ) : (
            tree.map(entry => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                onLoadChildren={loadChildren}
                loadingDirs={loadingDirs}
              />
            ))
          )}
        </div>
      </aside>

      {/* file content */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#1e1e2e]">
        {selectedPath ? (
          <>
            <div className="shrink-0 border-b border-[#45475a] bg-[#313244] px-4 py-2">
              <div className="text-sm font-bold text-[#cdd6f4]">{fileName}</div>
              <div className="truncate font-mono text-[10px] text-[#7f849c]">{selectedPath}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <FileContent path={selectedPath} root={root} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-sm text-[#7f849c]">
            <File className="mb-2 size-8 text-[#45475a]" />
            Select a file to view
          </div>
        )}
      </main>
    </div>
  )
}

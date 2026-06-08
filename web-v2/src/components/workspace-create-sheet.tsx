import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, ChevronUp, Folder, FolderOpen, Check } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useApi } from '@/hooks/use-api'
import type { ProjectInfo, WorkspaceInfo } from '@/hooks/use-work-context'

interface BrowseResult {
  current: string
  parent: string | null
  directories: { name: string; path: string }[]
}

interface AgentProvider {
  type: string
  model?: string | null
}

interface WorkspaceCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: ProjectInfo[]
  onCreated: (workspace: WorkspaceInfo) => void
  createWorkspace: (name: string, opts?: { cwd?: string; agent?: string }) => Promise<WorkspaceInfo>
  /** When set, the sheet is in "configure existing workspace" mode */
  existingWorkspace?: WorkspaceInfo
  updateWorkspaceConfig?: (name: string, opts: { cwd?: string; agent?: string; originalName?: string }) => Promise<void>
  /** 打开时预选 cwd,用于 "Bind project" 模式 */
  initialCwd?: string
}

export function WorkspaceCreateSheet({ open, onOpenChange, projects, onCreated, createWorkspace, existingWorkspace, updateWorkspaceConfig, initialCwd }: WorkspaceCreateSheetProps) {
  const isConfigMode = !!existingWorkspace
  const { get } = useApi()
  const [name, setName] = useState('')
  const [selectedCwd, setSelectedCwd] = useState<string | undefined>()
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>()
  const [browsePath, setBrowsePath] = useState('~')
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [pastePath, setPastePath] = useState('')
  const [pasteValidating, setPasteValidating] = useState(false)
  const [agents, setAgents] = useState<Record<string, AgentProvider>>({})
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (existingWorkspace) {
      setName(existingWorkspace.name)
      setSelectedCwd(existingWorkspace.cwd)
      setSelectedAgent(existingWorkspace.agent)
      setBrowsePath(existingWorkspace.cwd || '~')
    } else if (initialCwd) {
      setName('')
      setSelectedCwd(initialCwd)
      setSelectedAgent(undefined)
      setBrowsePath(initialCwd)
    } else {
      setName('')
      setSelectedCwd(undefined)
      setSelectedAgent(undefined)
      setBrowsePath('~')
    }
    setBrowseResult(null)
    setError(null)
    get<{ agents?: { providers?: Record<string, AgentProvider> } }>('/api/config-summary')
      .then(data => { if (data.agents?.providers) setAgents(data.agents.providers) })
      .catch(() => {})
  }, [open, existingWorkspace, get, initialCwd])

  useEffect(() => {
    if (!open) return
    setBrowseLoading(true)
    get<BrowseResult>('/api/browse', { path: browsePath })
      .then(setBrowseResult)
      .catch(() => setBrowseResult(null))
      .finally(() => setBrowseLoading(false))
  }, [open, browsePath, get])

  const handleSelectProject = useCallback((path: string) => {
    setSelectedCwd(path)
    setBrowsePath(path)
  }, [])

  const handleNavigate = useCallback((path: string) => {
    setBrowsePath(path)
  }, [])

  const handleSelectCurrent = useCallback(() => {
    if (browseResult?.current) {
      setSelectedCwd(browseResult.current)
    }
  }, [browseResult])

  // Paste path:Enter 后用 /api/browse 校验;成功就应用;失败在 error 区显示
  const handleApplyPastePath = useCallback(async () => {
    const p = pastePath.trim()
    if (!p) return
    setPasteValidating(true)
    try {
      const res = await get<BrowseResult>('/api/browse', { path: p })
      // 后端会把 `current` 返回为规范化后的绝对路径
      setSelectedCwd(res.current)
      setBrowsePath(res.current)
      setPastePath('')
      setError(null)
    } catch (e) {
      setError(`无法访问路径: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPasteValidating(false)
    }
  }, [pastePath, get])

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    try {
      if (isConfigMode && updateWorkspaceConfig) {
        await updateWorkspaceConfig(name.trim(), { cwd: selectedCwd, agent: selectedAgent, originalName: existingWorkspace?.name })
        onOpenChange(false)
      } else {
        const workspace = await createWorkspace(name.trim(), { cwd: selectedCwd, agent: selectedAgent })
        onCreated(workspace)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }, [name, selectedCwd, selectedAgent, isConfigMode, createWorkspace, updateWorkspaceConfig, onCreated, onOpenChange, existingWorkspace?.name])

  const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
  const agentNames = Object.keys(agents)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md w-full flex flex-col">
        <SheetHeader>
          <SheetTitle>{isConfigMode ? '配置 Workspace' : '创建 Workspace'}</SheetTitle>
          <SheetDescription>{isConfigMode ? '为此 Workspace 设置本地工作目录和 Agent' : '设置名称、工作目录和 Agent'}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 flex-1 min-h-0">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">名称</label>
            <Input
              placeholder="Workspace name"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
              readOnly={existingWorkspace?.source === 'main'}
              autoFocus
            />
          </div>

          {/* Agent selector */}
          {agentNames.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Agent</label>
              <select
                value={selectedAgent ?? ''}
                onChange={e => setSelectedAgent(e.target.value || undefined)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">默认</option>
                {agentNames.map(name => (
                  <option key={name} value={name}>
                    {name} ({agents[name].type}{agents[name].model ? ` · ${agents[name].model}` : ''})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Selected CWD display */}
          {selectedCwd && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <Check className="size-3.5 text-primary shrink-0" />
              <span className="truncate text-primary">{shortPath(selectedCwd)}</span>
              <button
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedCwd(undefined)}
              >
                清除
              </button>
            </div>
          )}

          {/* Paste path 输入 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">粘贴路径</label>
            <Input
              placeholder="/path/to/project 或 ~"
              value={pastePath}
              onChange={e => setPastePath(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleApplyPastePath() }}
              disabled={pasteValidating}
            />
            <p className="text-[10px] text-muted-foreground">按 Enter 校验并应用</p>
          </div>

          {/* Quick pick from projects */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">快速选择项目</label>
            <div className="space-y-1">
              {projects.filter(p => p.source !== 'persona').map(project => (
                <button
                  key={project.id}
                  onClick={() => handleSelectProject(project.path)}
                  className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-left transition-colors hover:bg-accent ${
                    selectedCwd === project.path ? 'bg-accent text-accent-foreground' : ''
                  }`}
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{project.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground truncate max-w-[140px]">{shortPath(project.path)}</span>
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Folder browser */}
          <div className="flex flex-col gap-1.5 flex-1 min-h-0">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">浏览目录</label>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleSelectCurrent}
                disabled={!browseResult?.current}
                className="ml-auto text-xs"
              >
                选择当前目录
              </Button>
            </div>

            {/* Current path + up */}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              {browseResult?.parent && (
                <button
                  onClick={() => handleNavigate(browseResult.parent!)}
                  className="shrink-0 rounded p-0.5 hover:bg-accent"
                >
                  <ChevronUp className="size-3.5" />
                </button>
              )}
              <span className="truncate">{browseResult?.current ? shortPath(browseResult.current) : browsePath}</span>
            </div>

            {/* Directory list */}
            <ScrollArea className="flex-1 min-h-0 rounded-md border">
              <div className="p-1">
                {browseLoading ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">加载中...</div>
                ) : browseResult?.directories.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">空目录</div>
                ) : (
                  browseResult?.directories.map(dir => (
                    <button
                      key={dir.path}
                      onClick={() => handleNavigate(dir.path)}
                      className="w-full flex items-center gap-2 rounded px-2 py-1 text-sm text-left transition-colors hover:bg-accent"
                    >
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{dir.name}</span>
                      <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground" />
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        {error && (
          <div className="mx-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <SheetFooter>
          <div className="flex gap-2 w-full">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button className="flex-1" onClick={handleCreate} disabled={!name.trim() || creating}>
              {creating ? (isConfigMode ? '保存中...' : '创建中...') : (isConfigMode ? '保存' : '创建')}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  FileCode2,
  ListTodo,
  MessageSquare,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useStatus } from '@/hooks/use-status'
import { useApi } from '@/hooks/use-api'
import { useWebSocket } from '@/hooks/use-websocket'
import { useSessions, type Session } from '@/hooks/use-sessions'
import { useWorkContext, type ProjectInfo, type WorkspaceInfo } from '@/hooks/use-work-context'
import { WorkspaceCreateSheet } from '@/components/workspace-create-sheet'
import { cn } from '@/lib/utils'

type BrowseMode = 'projects' | 'workspaces'

export interface ShellOutletContext {
  activeProject?: ProjectInfo
  activeWorkspace?: WorkspaceInfo
  directorLabel: string
  workspaceName?: string
  sessions: Session[]
  activeSession?: string
  activeSessionInfo?: Session
  setActiveSession: (id: string | undefined) => void
}

const navItems = [
  { to: '/', icon: MessageSquare, label: 'Chat' },
  { to: '/tasks', icon: ListTodo, label: 'Tasks' },
  { to: '/files', icon: FileCode2, label: 'Files' },
]

function statusColor(status: string) {
  if (status === 'live') return 'bg-[#a6e3a1] shadow-[0_0_6px_rgba(166,227,161,.45)]'
  if (status === 'busy') return 'bg-[#f9e2af] shadow-[0_0_6px_rgba(249,226,175,.35)]'
  return 'bg-[#6c7086]'
}

function shortPath(path?: string) {
  if (!path) return '-'
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function Badge({ children, tone = 'blue' }: { children: string; tone?: 'green' | 'yellow' | 'blue' | 'mauve' }) {
  const colors = {
    green: 'bg-[#a6e3a1]/15 text-[#a6e3a1]',
    yellow: 'bg-[#f9e2af]/15 text-[#f9e2af]',
    blue: 'bg-[#89b4fa]/15 text-[#89b4fa]',
    mauve: 'bg-[#cba6f7]/15 text-[#cba6f7]',
  }
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[.03em]', colors[tone])}>
      {children}
    </span>
  )
}

function Header({
  activeProject,
  activeWorkspace,
  activeSession,
  mode,
}: {
  activeProject?: ProjectInfo
  activeWorkspace?: WorkspaceInfo
  activeSession?: Session
  mode: BrowseMode
}) {
  const status = useStatus()
  const { status: wsStatus } = useWebSocket()
  const alive = status?.system?.directorAlive ?? false
  const contextPercent = status?.context?.percent ?? 0

  return (
    <header className="flex h-[34px] shrink-0 items-center gap-4 border-b border-[#313244] bg-[#181825] px-3 text-xs text-[#7f849c]">
      <div className="text-[15px] font-bold tracking-[.03em] text-[#b4befe]">Persona Shell</div>
      <div className="flex items-center gap-1.5">
        <span className={cn('size-[7px] rounded-full', wsStatus === 'connected' ? statusColor('live') : 'bg-[#f38ba8]')} />
        <strong className="font-mono text-[#bac2de]">{wsStatus === 'connected' ? 'Healthy' : 'Offline'}</strong>
      </div>
      <div>Project <strong className="font-mono text-[#bac2de]">{activeProject?.name ?? 'project'}</strong></div>
      <div>Workspace <strong className="font-mono text-[#bac2de]">{activeWorkspace?.name ?? 'workspace'}</strong></div>
      <div>Session <strong className="font-mono text-[#bac2de]">{activeSession?.label ?? 'session'}</strong></div>
      <div>Browse <strong className="font-mono text-[#bac2de]">{mode === 'projects' ? 'Projects' : 'Workspaces'}</strong></div>
      <div className="flex items-center gap-1.5">
        <Bot className="size-3 text-[#7f849c]" />
        Director <strong className="font-mono text-[#bac2de]">{alive ? 'Alive +3' : 'Waiting'}</strong>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span>Context</span>
        <span className="h-1.5 w-14 overflow-hidden rounded bg-[#45475a]">
          <span
            className={cn('block h-full rounded', contextPercent > 80 ? 'bg-[#f38ba8]' : contextPercent > 50 ? 'bg-[#f9e2af]' : 'bg-[#a6e3a1]')}
            style={{ width: `${Math.min(contextPercent || 17, 100)}%` }}
          />
        </span>
        <strong className="font-mono text-[#bac2de]">{contextPercent || 17}%</strong>
      </div>
    </header>
  )
}

function SidebarItem({
  name,
  path,
  meta,
  status,
  badges,
  active,
  onClick,
}: {
  name: string
  path: string
  meta?: string
  status: 'live' | 'busy' | 'off'
  badges: string[]
  active?: boolean
  onClick?: () => void
}) {
  const tones = ['green', 'blue', 'yellow', 'mauve'] as const

  return (
    <button
      onClick={onClick}
      className={cn(
        'grid w-full grid-cols-[14px_1fr_auto] items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-[#313244]',
        active && 'bg-[#45475a]'
      )}
    >
      <span className={cn('mt-1.5 size-[7px] rounded-full', statusColor(status))} />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-[#bac2de]">{name}</span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-[#7f849c]">{shortPath(path)}</span>
        <span className="mt-1.5 flex flex-wrap gap-1">
          {badges.map((badge, index) => (
            <Badge key={badge} tone={tones[index % tones.length]}>{badge}</Badge>
          ))}
        </span>
      </span>
      <span className="font-mono text-[10px] text-[#6c7086]">{meta}</span>
    </button>
  )
}

function Sidebar({
  mode,
  setMode,
  projects,
  workspaces,
  activeProject,
  activeWorkspace,
  setActiveWorkspace,
  onCreateWorkspace,
  onConfigureWorkspace,
  onRestart,
}: {
  mode: BrowseMode
  setMode: (mode: BrowseMode) => void
  projects: ProjectInfo[]
  workspaces: WorkspaceInfo[]
  activeProject?: ProjectInfo
  activeWorkspace?: WorkspaceInfo
  setActiveWorkspace: (id: string) => void
  onCreateWorkspace: () => void
  onConfigureWorkspace: (workspace: WorkspaceInfo) => void
  onRestart: () => void
}) {
  const title = mode === 'projects' ? 'Projects' : 'Workspaces'
  const [emptyWorkspacesOpen, setEmptyWorkspacesOpen] = useState(false)
  const visibleWorkspaces = workspaces.filter(workspace =>
    workspace.source === 'main' ||
    (workspace.localMessageCount ?? 0) > 0 ||
    workspace.id === activeWorkspace?.id
  )
  const emptyWorkspaces = workspaces.filter(workspace =>
    workspace.source !== 'main' &&
    (workspace.localMessageCount ?? 0) === 0 &&
    workspace.id !== activeWorkspace?.id
  )

  return (
    <aside className="flex min-w-0 flex-col overflow-hidden border-r border-[#313244] bg-[#181825]">
      <section className="border-b border-[#313244] p-3">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#6c7086]">Browse Mode</div>
        <div className="grid grid-cols-2 gap-1 rounded-md bg-[#313244] p-1">
          {(['workspaces', 'projects'] as BrowseMode[]).map(value => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={cn(
                'h-6 rounded font-mono text-[11px] font-bold capitalize transition-colors',
                mode === value ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#7f849c] hover:text-[#cdd6f4]'
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="mt-2 truncate font-mono text-[10px] text-[#7f849c]">
          {mode === 'projects' ? 'selecting source directory' : `showing memory scopes under ${shortPath(activeWorkspace?.path)}`}
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="px-1 pb-2 text-[10px] font-bold uppercase tracking-[.08em] text-[#6c7086]">{title}</div>
        <div className="space-y-1">
          {mode === 'projects'
            ? projects.map((project, index) => (
              <SidebarItem
                key={project.id}
                name={project.name}
                path={project.path}
                status={index === 0 ? 'live' : 'off'}
                badges={[project.source]}
                active={project.id === activeProject?.id}
              />
            ))
            : (
              <>
                {visibleWorkspaces.map(workspace => (
                  <SidebarItem
                    key={workspace.id}
                    name={workspace.name}
                    path={workspace.cwd || workspace.path}
                    meta={workspace.source === 'main' ? 'root' : String(workspace.localMessageCount ?? 0)}
                    status={workspace.id === activeWorkspace?.id ? 'live' : 'off'}
                    badges={[
                      workspace.source,
                      ...((workspace.localMessageCount ?? 0) > 0 ? [`${workspace.localMessageCount} msg`] : []),
                    ]}
                    active={workspace.id === activeWorkspace?.id}
                    onClick={() => setActiveWorkspace(workspace.id)}
                  />
                ))}
                {emptyWorkspaces.length > 0 && (
                  <div className="pt-1">
                    <button
                      onClick={() => setEmptyWorkspacesOpen(open => !open)}
                      className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]"
                    >
                      <ChevronRight className={cn('size-3 transition-transform', emptyWorkspacesOpen && 'rotate-90')} />
                      <span className="min-w-0 flex-1 truncate text-left">No Local History</span>
                      <span className="rounded bg-[#313244] px-1.5 py-0.5 text-[9px] text-[#bac2de]">{emptyWorkspaces.length}</span>
                    </button>
                    {emptyWorkspacesOpen && (
                      <div className="mt-1 space-y-1">
                        {emptyWorkspaces.map(workspace => (
                          <SidebarItem
                            key={workspace.id}
                            name={workspace.name}
                            path={workspace.cwd || workspace.path}
                            meta="0"
                            status="off"
                            badges={[workspace.source]}
                            active={workspace.id === activeWorkspace?.id}
                            onClick={() => {
                              if (!workspace.cwd) {
                                onConfigureWorkspace(workspace)
                              } else {
                                setActiveWorkspace(workspace.id)
                              }
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          <button
            onClick={mode === 'workspaces' ? onCreateWorkspace : undefined}
            className="grid w-full grid-cols-[14px_1fr] items-start gap-2 rounded-md px-2 py-2 text-left text-xs text-[#7f849c] hover:bg-[#313244]"
          >
            <Plus className="mt-0.5 size-3.5 text-[#cba6f7]" />
            <span>
              <span className="block font-semibold text-[#bac2de]">{mode === 'projects' ? 'Bind project' : 'Create workspace'}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-[#7f849c]">
                {mode === 'projects' ? 'attach a local source directory' : 'new memory scope under selected project'}
              </span>
            </span>
          </button>
        </div>
      </div>

      <section className="border-t border-[#313244] p-2">
        <button
          onClick={onRestart}
          className="flex h-8 w-full items-center gap-2 rounded px-2 text-xs text-[#a6adc8] hover:bg-[#313244]"
        >
          <RefreshCw className="size-3.5" />
          Restart Shell
        </button>
      </section>
    </aside>
  )
}

const WS_STORAGE_KEY = 'persona-shell:v2:active-workspace-id'

export function RootLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<BrowseMode>('workspaces')
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | undefined>(
    () => localStorage.getItem(WS_STORAGE_KEY) || undefined
  )
  const setActiveWorkspaceId = useCallback((id: string | undefined) => {
    if (id) localStorage.setItem(WS_STORAGE_KEY, id)
    else localStorage.removeItem(WS_STORAGE_KEY)
    setActiveWorkspaceIdState(id)
  }, [])
  const { context, createWorkspace, updateWorkspaceConfig, loadContext } = useWorkContext()
  const isSubPage = location.pathname !== '/' && location.pathname !== ''
  const activeProject = context.projects[0]
  const activeWorkspaceInfo = context.workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? context.workspaces[0]
  const activeDirectorLabel = activeWorkspaceInfo?.directorLabel ?? 'main'
  const { sessions, activeSession, setActiveSession } = useSessions(activeDirectorLabel)
  const activeSessionInfo = sessions.find(session => session.id === activeSession) ?? sessions[0]
  const { on } = useWebSocket()

  useEffect(() => {
    if (Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    return on('task_callback', (data) => {
      const text = (data.text as string) || '后台任务完成'
      if (Notification.permission === 'granted' && document.hidden) {
        new Notification('Persona Shell', { body: text, icon: '/v2/favicon.ico' })
      }
    })
  }, [on])

  useEffect(() => {
    return on('context_update', () => { loadContext() })
  }, [on, loadContext])

  useEffect(() => {
    if (!context.workspaces.length) return
    if (activeWorkspaceId && context.workspaces.some(workspace => workspace.id === activeWorkspaceId)) return
    setActiveWorkspaceId(context.activeWorkspaceId ?? context.workspaces[0]?.id)
  }, [activeWorkspaceId, context.activeWorkspaceId, context.workspaces, setActiveWorkspaceId])

  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [configWorkspace, setConfigWorkspace] = useState<WorkspaceInfo | undefined>()

  const handleCreateWorkspace = () => {
    setConfigWorkspace(undefined)
    setCreateSheetOpen(true)
  }

  const handleConfigureWorkspace = (workspace: WorkspaceInfo) => {
    setConfigWorkspace(workspace)
    setCreateSheetOpen(true)
  }

  const handleWorkspaceCreated = (workspace: WorkspaceInfo) => {
    setActiveWorkspaceId(workspace.id)
    setMode('workspaces')
    setCreateSheetOpen(false)
  }

  const { post } = useApi()
  const handleRestart = useCallback(async () => {
    if (!window.confirm('确定要重启 Shell 吗？')) return
    try {
      const res = await post<{ ok: boolean; message?: string }>('/api/send', { text: '/shell-restart' })
      if (!res.ok && res.message) {
        if (window.confirm(`${res.message}\n\n是否强制重启？`)) {
          await post('/api/send', { text: '/shell-restart --force' })
        }
      }
    } catch {
      window.alert('重启请求失败')
    }
  }, [post])

  const isTasksPage = location.pathname === '/tasks'

  return (
    <div className="flex h-screen flex-col bg-[#1e1e2e] text-[#cdd6f4]">
      <Header activeProject={activeProject} activeWorkspace={activeWorkspaceInfo} activeSession={activeSessionInfo} mode={mode} />
      <div className={cn('min-h-0 flex-1', isTasksPage ? 'flex' : 'grid grid-cols-[292px_minmax(520px,1fr)]')}>
        {!isTasksPage && (
          <Sidebar
            mode={mode}
            setMode={setMode}
            projects={context.projects}
            workspaces={context.workspaces}
            activeProject={activeProject}
            activeWorkspace={activeWorkspaceInfo}
            setActiveWorkspace={setActiveWorkspaceId}
            onCreateWorkspace={handleCreateWorkspace}
            onConfigureWorkspace={handleConfigureWorkspace}
            onRestart={handleRestart}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#1e1e2e]">
          <div className="flex min-h-[42px] shrink-0 items-center gap-2 border-b border-[#45475a] bg-[#313244] px-4">
            {isSubPage ? (
              <button
                onClick={() => navigate('/')}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 font-mono text-[11px] font-bold text-[#89b4fa] hover:bg-[#45475a] transition-colors"
              >
                <ArrowLeft className="size-3.5" />
                Chat
              </button>
            ) : (
              <span className="font-mono text-[#89b4fa]">&lt;-</span>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-[#cdd6f4]">
                Project / {activeProject?.name ?? '-'} · Workspace / {activeWorkspaceInfo?.name ?? '-'}
              </div>
              <div className="truncate font-mono text-[11px] text-[#7f849c]">
                project cwd: {shortPath(activeProject?.path)} | workspace: {shortPath(activeWorkspaceInfo?.path)} | director: {activeDirectorLabel} | session id: {activeSessionInfo?.id ?? '-'}
              </div>
            </div>
            <nav className="ml-auto flex shrink-0 gap-1">
              {navItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => cn(
                    'inline-flex h-6 items-center gap-1.5 rounded px-2 font-mono text-[11px] font-bold transition-colors',
                    isActive ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#7f849c] hover:text-[#cdd6f4]'
                  )}
                >
                  <item.icon className="size-3.5" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <Outlet context={{
            activeProject,
            activeWorkspace: activeWorkspaceInfo,
            directorLabel: activeDirectorLabel,
            workspaceName: activeWorkspaceInfo?.source === 'memory' ? activeWorkspaceInfo.name : undefined,
            sessions,
            activeSession: activeSessionInfo?.id,
            activeSessionInfo,
            setActiveSession,
          } satisfies ShellOutletContext} />
        </main>
      </div>
      <WorkspaceCreateSheet
        open={createSheetOpen}
        onOpenChange={setCreateSheetOpen}
        projects={context.projects}
        onCreated={handleWorkspaceCreated}
        createWorkspace={createWorkspace}
        existingWorkspace={configWorkspace}
        updateWorkspaceConfig={updateWorkspaceConfig}
      />
    </div>
  )
}

import { Fragment, useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import {
  ArrowLeft,
  Archive,
  Bot,
  ChevronRight,
  EyeOff,
  Eye,
  FileCode2,
  ListTodo,
  Menu,
  MessageSquare,
  Plus,
  Settings2,
} from 'lucide-react'
import { useStatus } from '@/hooks/use-status'
import { useWebSocket } from '@/hooks/use-websocket'
import { useSessions, type Session } from '@/hooks/use-sessions'
import { useWorkContext, type ProjectInfo, type WorkspaceInfo } from '@/hooks/use-work-context'
import { WorkspaceCreateSheet } from '@/components/workspace-create-sheet'
import { StatusBar } from '@/components/status-bar'
import { DirectorPanel } from '@/components/director-panel'
import { RestartShellButton } from '@/components/restart-shell-button'
import { CommandPalette } from '@/components/command-palette'
import { SwitchSheet } from '@/components/switch-sheet'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useSessionsMut } from '@/hooks/use-sessions-mut'
import { ShortcutRoot } from '@/hooks/use-shortcut'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

type BrowseMode = 'projects' | 'workspaces'

export interface ShellOutletContext {
  activeProject?: ProjectInfo
  activeWorkspace?: WorkspaceInfo
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
  onSwitchClick,
}: {
  activeProject?: ProjectInfo
  activeWorkspace?: WorkspaceInfo
  activeSession?: Session
  mode: BrowseMode
  onSwitchClick: () => void
}) {
  const status = useStatus()
  const { status: wsStatus } = useWebSocket()
  const alive = status?.system?.directorAlive ?? false

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
      <div className="ml-auto flex items-center gap-1.5">
        <Bot className="size-3 text-[#7f849c]" />
        Director <strong className="font-mono text-[#bac2de]">{alive ? 'Alive +3' : 'Waiting'}</strong>
      </div>
      <button
        onClick={onSwitchClick}
        className="rounded px-2 py-0.5 text-xs text-[#89b4fa] hover:bg-[#313244]"
        title="切换 Agent / Persona (Mod+K)"
      >
        Switch…
      </button>
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
  sessions,
  activeSession,
  setActiveSession,
  onCreateWorkspace,
  onConfigureWorkspace,
  onCreateSession,
  onArchiveSession,
  onBindProject,
  onToggleHidden,
}: {
  mode: BrowseMode
  setMode: (mode: BrowseMode) => void
  projects: ProjectInfo[]
  workspaces: WorkspaceInfo[]
  activeProject?: ProjectInfo
  activeWorkspace?: WorkspaceInfo
  setActiveWorkspace: (id: string) => void
  sessions: Session[]
  activeSession?: string
  setActiveSession: (id: string | undefined) => void
  onCreateWorkspace: () => void
  onConfigureWorkspace: (workspace: WorkspaceInfo) => void
  onCreateSession: (workspace: WorkspaceInfo) => void
  onArchiveSession: (session: Session) => void
  onBindProject: (project: ProjectInfo) => void
  onToggleHidden: (workspace: WorkspaceInfo) => void
}) {
  const title = mode === 'projects' ? 'Projects' : 'Workspaces'
  const [hiddenWorkspacesOpen, setHiddenWorkspacesOpen] = useState(false)
  const visibleWorkspaces = workspaces.filter(workspace =>
    workspace.source === 'main' || !workspace.hidden
  )
  const hiddenWorkspaces = workspaces.filter(workspace =>
    workspace.source !== 'main' && workspace.hidden
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
                onClick={project.source !== 'persona' ? () => onBindProject(project) : undefined}
              />
            ))
            : (
              <>
                {visibleWorkspaces.map(workspace => {
                  const isActive = workspace.id === activeWorkspace?.id
                  return (
                    <Fragment key={workspace.id}>
                      <div className="flex items-center gap-1">
                        <SidebarItem
                          name={workspace.name}
                          path={workspace.cwd || workspace.path}
                          meta={workspace.source === 'main' ? 'root' : (workspace.localSessionCount ?? 0) > 0 ? String(workspace.localMessageCount ?? 0) : undefined}
                          status={isActive ? 'live' : 'off'}
                          badges={[
                            workspace.source,
                            ...((workspace.localMessageCount ?? 0) > 0 ? [`${workspace.localMessageCount} msg`] : []),
                          ]}
                          active={isActive}
                          onClick={() => setActiveWorkspace(workspace.id)}
                        />
                        {workspace.source !== 'main' && (
                          <>
                            <button
                              onClick={() => onConfigureWorkspace(workspace)}
                              className="shrink-0 rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]"
                              title="配置 workspace"
                              aria-label="Configure workspace"
                            >
                              <Settings2 className="size-3" />
                            </button>
                            <button
                              onClick={() => onCreateSession(workspace)}
                              className="shrink-0 rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]"
                              title={`在 ${workspace.name} 下新建 session`}
                              aria-label="New session"
                            >
                              <Plus className="size-3" />
                            </button>
                            <button
                              onClick={() => onToggleHidden(workspace)}
                              className="shrink-0 rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#f38ba8]"
                              title="隐藏"
                              aria-label="Hide workspace"
                            >
                              <EyeOff className="size-3" />
                            </button>
                          </>
                        )}
                      </div>
                      {/* sessions 嵌在它所属的 workspace 下方,以左侧 border 表达从属关系 */}
                      {isActive && sessions.length > 0 && (
                        <div className="mb-1 ml-3 space-y-0.5 border-l border-[#45475a] pl-2 pt-0.5">
                          {sessions.map(session => {
                            // RootLayout 用 activeSessionInfo = sessions.find(s.id === activeSession)
                            // 必须传 id 而不是 label,否则 find 匹配失败 fallback 到 sessions[0],
                            // UI 卡在旧 session,直到下一次 loadSessions polling 校正(~1-5s)
                            const selected = activeSession === session.id
                            return (
                              <div
                                key={session.id}
                                className={cn(
                                  'flex w-full items-center gap-1.5 rounded font-mono text-[11px] transition-colors',
                                  selected
                                    ? 'bg-[#45475a] text-[#cdd6f4]'
                                    : 'text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]'
                                )}
                                title={session.label || session.name || session.id}
                              >
                                <button
                                  onClick={() => setActiveSession(session.id)}
                                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left"
                                >
                                  <span className={cn('size-[6px] shrink-0 rounded-full', session.alive ? 'bg-[#a6e3a1]' : 'bg-[#6c7086]')} />
                                  <span className="min-w-0 flex-1 truncate">{session.label || session.name || session.id}</span>
                                  {(session.messageCount ?? 0) > 0 && (
                                    <span className="shrink-0 text-[10px] text-[#6c7086]">{session.messageCount}</span>
                                  )}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); onArchiveSession(session) }}
                                  className="shrink-0 rounded p-1 text-[#6c7086] hover:bg-[#313244] hover:text-[#f38ba8]"
                                  title="归档 session"
                                  aria-label="Archive session"
                                >
                                  <Archive className="size-3" />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </Fragment>
                  )
                })}
                {hiddenWorkspaces.length > 0 && (
                  <div className="pt-1">
                    <button
                      onClick={() => setHiddenWorkspacesOpen(open => !open)}
                      className="flex h-7 w-full items-center gap-1.5 rounded px-1.5 font-mono text-[10px] font-bold uppercase tracking-[.06em] text-[#7f849c] hover:bg-[#313244] hover:text-[#cdd6f4]"
                    >
                      <ChevronRight className={cn('size-3 transition-transform', hiddenWorkspacesOpen && 'rotate-90')} />
                      <span className="min-w-0 flex-1 truncate text-left">Hidden</span>
                      <span className="rounded bg-[#313244] px-1.5 py-0.5 text-[9px] text-[#bac2de]">{hiddenWorkspaces.length}</span>
                    </button>
                    {hiddenWorkspacesOpen && (
                      <div className="mt-1 space-y-1">
                        {hiddenWorkspaces.map(workspace => (
                          <div key={workspace.id} className="flex items-center gap-1">
                            <SidebarItem
                              name={workspace.name}
                              path={workspace.cwd || workspace.path}
                              status="off"
                              badges={[workspace.source]}
                              active={workspace.id === activeWorkspace?.id}
                              onClick={() => setActiveWorkspace(workspace.id)}
                            />
                            <button
                              onClick={() => onToggleHidden(workspace)}
                              className="shrink-0 rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#a6e3a1]"
                              title="显示"
                              aria-label="Show workspace"
                            >
                              <Eye className="size-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          <button
            onClick={mode === 'workspaces' ? onCreateWorkspace : () => onBindProject(activeProject ?? projects[0])}
            className="grid w-full grid-cols-[14px_1fr] items-start gap-2 rounded-md px-2 py-2 text-left text-xs text-[#7f849c] hover:bg-[#313244]"
          >            <Plus className="mt-0.5 size-3.5 text-[#cba6f7]" />
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
        <RestartShellButton />
        <DirectorPanel directorLabel="main" />
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
  const { context, createWorkspace, updateWorkspaceConfig, setWorkspaceVisibility, loadContext } = useWorkContext()
  const isSubPage = location.pathname !== '/' && location.pathname !== ''
  const activeProject = context.projects[0]
  const activeWorkspaceInfo = context.workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? context.workspaces[0]
  const activeWorkspaceName = activeWorkspaceInfo?.source === 'memory' ? activeWorkspaceInfo.name : (activeWorkspaceInfo?.name === 'Main director' ? 'main' : activeWorkspaceInfo?.name)
  const { sessions, activeSession, setActiveSession, loadSessions } = useSessions(activeWorkspaceName)
  const activeSessionInfo = sessions.find(session => session.id === activeSession) ?? sessions[0]
  const { on } = useWebSocket()

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    return on('task_callback', (data) => {
      const text = (data.text as string) || '后台任务完成'
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        new Notification('Persona Shell', { body: text, icon: '/favicon.ico' })
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
  // WP5: 新建 session / 归档 session / 绑定 project 的弹窗状态
  const [newSessionTarget, setNewSessionTarget] = useState<WorkspaceInfo | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<Session | null>(null)
  const [bindProjectTarget, setBindProjectTarget] = useState<ProjectInfo | null>(null)
  const sessionsMut = useSessionsMut()

  const handleCreateWorkspace = () => {
    setConfigWorkspace(undefined)
    setBindProjectTarget(null)
    setCreateSheetOpen(true)
  }

  const handleConfigureWorkspace = (workspace: WorkspaceInfo) => {
    setConfigWorkspace(workspace)
    setBindProjectTarget(null)
    setCreateSheetOpen(true)
  }

  // Bind project 接线:打开 sheet 时把 project 设为"将作为 cwd 预选"
  const handleBindProject = (project: ProjectInfo) => {
    setConfigWorkspace(undefined)
    setBindProjectTarget(project)
    setCreateSheetOpen(true)
  }

  const handleWorkspaceCreated = (workspace: WorkspaceInfo) => {
    setActiveWorkspaceId(workspace.id)
    setMode('workspaces')
    setCreateSheetOpen(false)
  }

  const isTasksPage = location.pathname === '/tasks'
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [switchSheetOpen, setSwitchSheetOpen] = useState(false)

  return (
    <div className="flex h-screen flex-col bg-[#1e1e2e] text-[#cdd6f4]">
      <Header
        activeProject={activeProject}
        activeWorkspace={activeWorkspaceInfo}
        activeSession={activeSessionInfo}
        mode={mode}
        onSwitchClick={() => setSwitchSheetOpen(true)}
      />
      <div className={cn('min-h-0 flex-1', isTasksPage ? 'flex' : isMobile ? 'flex flex-col' : 'grid grid-cols-[292px_minmax(520px,1fr)]')}>
        {!isTasksPage && !isMobile && (
          <Sidebar
            mode={mode}
            setMode={setMode}
            projects={context.projects}
            workspaces={context.workspaces}
            activeProject={activeProject}
            activeWorkspace={activeWorkspaceInfo}
            setActiveWorkspace={setActiveWorkspaceId}
            sessions={sessions}
            activeSession={activeSessionInfo?.id}
            setActiveSession={setActiveSession}
            onCreateWorkspace={handleCreateWorkspace}
            onConfigureWorkspace={handleConfigureWorkspace}
            onCreateSession={(ws) => setNewSessionTarget(ws)}
            onArchiveSession={(s) => setArchiveTarget(s)}
            onBindProject={handleBindProject}
            onToggleHidden={(ws) => setWorkspaceVisibility(ws.name, !ws.hidden)}
          />
        )}
        {!isTasksPage && isMobile && (
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetTrigger asChild>
              <button
                className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[#45475a] bg-[#313244] px-3 text-xs text-[#bac2de] hover:bg-[#45475a]"
                aria-label="Open sidebar"
              >
                <Menu className="size-3.5" />
                Menu
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[292px] max-w-[80vw] p-0">
              <Sidebar
                mode={mode}
                setMode={setMode}
                projects={context.projects}
                workspaces={context.workspaces}
                activeProject={activeProject}
                activeWorkspace={activeWorkspaceInfo}
                setActiveWorkspace={setActiveWorkspaceId}
                sessions={sessions}
                activeSession={activeSessionInfo?.id}
                setActiveSession={(id) => { setActiveSession(id); setSidebarOpen(false) }}
                onCreateWorkspace={handleCreateWorkspace}
                onConfigureWorkspace={handleConfigureWorkspace}
                onCreateSession={(ws) => { setNewSessionTarget(ws); setSidebarOpen(false) }}
                onArchiveSession={(s) => { setArchiveTarget(s); setSidebarOpen(false) }}
                onBindProject={handleBindProject}
                onToggleHidden={(ws) => setWorkspaceVisibility(ws.name, !ws.hidden)}
              />
            </SheetContent>
          </Sheet>
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#1e1e2e]">
          <StatusBar />
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
                project cwd: {shortPath(activeProject?.path)} | workspace: {activeWorkspaceName ?? '-'} | session id: {activeSessionInfo?.id ?? '-'}
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
            workspaceName: activeWorkspaceName,
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
        initialCwd={bindProjectTarget?.path}
      />
      <ShortcutRoot />
      <CommandPalette />
      <SwitchSheet open={switchSheetOpen} onOpenChange={setSwitchSheetOpen} directorLabel="main" />
      <NewSessionDialog
        open={newSessionTarget !== null}
        onOpenChange={(open) => { if (!open) setNewSessionTarget(null) }}
        workspace={newSessionTarget?.name ?? ''}
        defaultAgent={newSessionTarget?.agent}
        onCreate={async ({ agent, sessionName }) => {
          if (!newSessionTarget) return
          const result = await sessionsMut.create(
            { workspace: newSessionTarget.name, agent },
            { onSuccess: () => { void loadSessions() } }
          )
          if (result?.sessionId) {
            if (sessionName) {
              await sessionsMut.rename(result.sessionId, sessionName)
            }
            setActiveSession(result.sessionId)
            void loadSessions()
          }
          setNewSessionTarget(null)
        }}
      />
      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}
        title="归档 Session"
        description={archiveTarget ? `确定要归档 "${archiveTarget.label || archiveTarget.id}" 吗?` : ''}
        confirmLabel="归档"
        destructive
        extraCheckboxes={[
          { id: 'killDirector', label: '同时关闭 Director 进程(默认仅标记归档,Director 继续运行)' },
        ]}
        onConfirm={async (extra) => {
          if (!archiveTarget) return
          await sessionsMut.archive(archiveTarget.id, {
            killDirector: !!extra.killDirector,
            onSuccess: () => { void loadSessions() },
          })
          setArchiveTarget(null)
        }}
      />
    </div>
  )
}

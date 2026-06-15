import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import {
  ArrowLeft,
  FileCode2,
  ListTodo,
  Menu,
  MessageSquare,
} from 'lucide-react'
import { useWebSocket } from '@/hooks/use-websocket'
import { useSessions, type Session } from '@/hooks/use-sessions'
import { useWorkContext, type ProjectInfo, type WorkspaceInfo } from '@/hooks/use-work-context'
import { WorkspaceCreateSheet } from '@/components/workspace-create-sheet'
import { CommandPalette } from '@/components/command-palette'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useSessionsMut } from '@/hooks/use-sessions-mut'
import { useAgents } from '@/hooks/use-agents'
import { ShortcutRoot } from '@/hooks/use-shortcut'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { Header } from '@/components/header'
import { Sidebar } from '@/components/sidebar'
import type { BrowseMode } from '@/components/sidebar'

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
  const activeWorkspaceName = activeWorkspaceInfo?.source === 'memory' ? activeWorkspaceInfo.name : (activeWorkspaceInfo?.name === 'Main' ? 'main' : activeWorkspaceInfo?.name)
  const { sessions, activeSession, setActiveSession, loadSessions } = useSessions(activeWorkspaceName)
  const activeSessionInfo = sessions.find(session => session.id === activeSession) ?? sessions[0]
  const { on } = useWebSocket()
  const { agents } = useAgents()
  const activeAgentName = activeSessionInfo?.agentName ?? activeWorkspaceInfo?.agent
  const activeAgent = activeAgentName ? agents[activeAgentName] : undefined
  const activeAgentType = activeSessionInfo?.agentType ?? activeAgent?.type
  const activeModel = activeSessionInfo?.model ?? activeAgent?.model

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

  return (
    <div className="flex h-screen flex-col bg-[#1e1e2e] text-[#cdd6f4]">
      <Header
        activeProject={activeProject}
        activeWorkspace={activeWorkspaceInfo}
        activeSession={activeSessionInfo}
        mode={mode}
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
          {!isTasksPage && <div className="flex min-h-[64px] shrink-0 items-center gap-2 border-b border-[#45475a] bg-[#313244] px-4 py-2">
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
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="truncate text-sm font-bold text-[#cdd6f4]">
                Workspace / {activeWorkspaceInfo?.name ?? '-'}
              </div>
              <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-[#7f849c]">
                <span className="min-w-0 max-w-full truncate">workspace: {activeWorkspaceName ?? '-'}</span>
                {activeWorkspaceInfo?.cwd && <span className="min-w-0 max-w-full truncate">cwd: {activeWorkspaceInfo.cwd.split('/').pop()}{activeWorkspaceInfo.gitBranch ? ` (${activeWorkspaceInfo.gitBranch})` : ''}</span>}
                <span className="min-w-0 max-w-full truncate">agent: {activeAgentName ?? '-'}{activeAgentType ? ` (${activeAgentType})` : ''}</span>
                {activeModel && <span className="min-w-0 max-w-full truncate">model: {activeModel}</span>}
                <span className="min-w-0 max-w-full truncate">session: {activeSessionInfo?.id ?? '-'}</span>
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
          </div>}
          <Outlet context={{
            activeProject,
            activeWorkspace: activeWorkspaceInfo,
            workspaceName: activeWorkspaceName,
            sessions,
            activeSession: activeSession ?? activeSessionInfo?.id,
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
      <NewSessionDialog
        open={newSessionTarget !== null}
        onOpenChange={(open) => { if (!open) setNewSessionTarget(null) }}
        workspace={newSessionTarget?.source === 'main' ? 'main' : newSessionTarget?.name ?? ''}
        defaultAgent={newSessionTarget?.agent}
        onCreate={async ({ agent, sessionName }) => {
          if (!newSessionTarget) return
          const targetWorkspaceName = newSessionTarget.source === 'main' ? 'main' : newSessionTarget.name
          const result = await sessionsMut.create(
            { workspace: targetWorkspaceName, agent },
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
        description={archiveTarget ? `归档将关闭 "${archiveTarget.label || archiveTarget.id}" 的 Director 进程。请确认重要信息已保存。` : ''}
        confirmLabel="确认归档"
        destructive
        onConfirm={async () => {
          if (!archiveTarget) return
          await sessionsMut.archive(archiveTarget.id, {
            killDirector: true,
            onSuccess: () => { void loadSessions() },
          })
          setArchiveTarget(null)
        }}
      />
    </div>
  )
}

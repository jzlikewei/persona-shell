import { Fragment, useState } from 'react'
import {
  Archive,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  Settings2,
} from 'lucide-react'
import type { ProjectInfo, WorkspaceInfo } from '@/hooks/use-work-context'
import type { Session } from '@/hooks/use-sessions'
import { DirectorPanel } from '@/components/director-panel'
import { RestartShellButton } from '@/components/restart-shell-button'
import { cn } from '@/lib/utils'
import { statusColor, Badge } from './header'

export type BrowseMode = 'projects' | 'workspaces'

function shortPath(path?: string) {
  if (!path) return '-'
  return path.replace(/^\/Users\/[^/]+/, '~')
}

export { shortPath }

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

export function Sidebar({
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
                          meta={workspace.source === 'main' ? 'root' : (workspace.localSessionCount ?? 0) > 0 ? `${workspace.localSessionCount} sessions` : undefined}
                          status={isActive ? 'live' : 'off'}
                          badges={[workspace.source]}
                          active={isActive}
                          onClick={() => setActiveWorkspace(workspace.id)}
                        />
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
                          {workspace.source !== 'main' && (
                            <button
                              onClick={() => onToggleHidden(workspace)}
                              className="shrink-0 rounded p-1 text-[#7f849c] hover:bg-[#313244] hover:text-[#f38ba8]"
                              title="隐藏"
                              aria-label="Hide workspace"
                            >
                              <EyeOff className="size-3" />
                            </button>
                          )}
                        </>
                      </div>
                      {/* sessions 嵌在它所属的 workspace 下方,以左侧 border 表达从属关系 */}
                      {isActive && sessions.length > 0 && (
                        <div className="mb-1 ml-3 space-y-0.5 border-l border-[#45475a] pl-2 pt-0.5">
                          {sessions.map(session => {
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

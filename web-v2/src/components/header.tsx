import { Bot } from 'lucide-react'
import { useStatus } from '@/hooks/use-status'
import { useWebSocket } from '@/hooks/use-websocket'
import type { ProjectInfo, WorkspaceInfo } from '@/hooks/use-work-context'
import type { Session } from '@/hooks/use-sessions'
import { cn } from '@/lib/utils'
import type { BrowseMode } from './sidebar'

function statusColor(status: string) {
  if (status === 'live') return 'bg-[#a6e3a1] shadow-[0_0_6px_rgba(166,227,161,.45)]'
  if (status === 'busy') return 'bg-[#f9e2af] shadow-[0_0_6px_rgba(249,226,175,.35)]'
  return 'bg-[#6c7086]'
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

export { statusColor, Badge }

export function Header({
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
  const alive = status?.system?.alive ?? false

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
        Agent <strong className="font-mono text-[#bac2de]">{alive ? 'Alive +3' : 'Waiting'}</strong>
      </div>
    </header>
  )
}

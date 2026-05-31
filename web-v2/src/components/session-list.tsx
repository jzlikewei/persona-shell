import { ScrollArea } from '@/components/ui/scroll-area'
import { Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Session } from '@/hooks/use-sessions'

interface SessionListProps {
  sessions: Session[]
  activeSession: string | undefined
  onSelect: (id: string | undefined) => void
}

export function SessionList({ sessions, activeSession, onSelect }: SessionListProps) {
  if (sessions.length === 0) return null

  return (
    <div className="border-t border-border">
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Directors
      </div>
      <ScrollArea className="max-h-[300px]">
        <div className="px-2 pb-2 space-y-0.5">
          <button
            onClick={() => onSelect(undefined)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors text-left',
              activeSession === undefined
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <Circle className="h-2 w-2 fill-current text-emerald-500" />
            <span className="truncate">Main</span>
          </button>
          {sessions.map(session => (
            <button
              key={session.id}
              onClick={() => onSelect(session.label || session.id)}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors text-left',
                (activeSession === session.label || activeSession === session.id)
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
            >
              <Circle className={cn('h-2 w-2 fill-current', session.alive ? 'text-emerald-500' : 'text-zinc-500')} />
              <span className="truncate flex-1">{session.label || session.name || session.id}</span>
              {(session.queueLength ?? 0) > 0 && (
                <span className="text-[10px] bg-muted px-1 rounded">{session.queueLength}</span>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

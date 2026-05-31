import { useStatus } from '@/hooks/use-status'
import { useWebSocket } from '@/hooks/use-websocket'
import { Circle, Wifi, WifiOff, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function StatusBar() {
  const status = useStatus()
  const { status: wsStatus } = useWebSocket()

  const alive = status?.system?.directorAlive ?? false
  const contextPercent = status?.context?.percent ?? 0
  const queueLength = status?.queue?.length ?? 0
  const tasksRunning = status?.tasks?.summary?.running ?? 0

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 border-b border-border text-xs text-muted-foreground bg-card/50 shrink-0">
      {/* WS connection */}
      <div className="flex items-center gap-1.5">
        {wsStatus === 'connected' ? (
          <Wifi className="h-3 w-3 text-emerald-500" />
        ) : wsStatus === 'connecting' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <WifiOff className="h-3 w-3 text-destructive" />
        )}
        <span className="hidden sm:inline">{wsStatus}</span>
      </div>

      {/* Director alive */}
      <div className="flex items-center gap-1.5">
        <Circle className={cn('h-2.5 w-2.5 fill-current', alive ? 'text-emerald-500' : 'text-destructive')} />
        <span>{alive ? 'Director alive' : 'Director dead'}</span>
      </div>

      {/* Context usage */}
      {status?.context && (
        <div className="flex items-center gap-1.5">
          <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                contextPercent > 80 ? 'bg-destructive' : contextPercent > 50 ? 'bg-yellow-500' : 'bg-emerald-500'
              )}
              style={{ width: `${Math.min(contextPercent, 100)}%` }}
            />
          </div>
          <span>{contextPercent}% ctx</span>
        </div>
      )}

      {/* Queue */}
      {queueLength > 0 && (
        <div className="flex items-center gap-1">
          <span className="font-medium text-foreground">{queueLength}</span>
          <span>queued</span>
        </div>
      )}

      {/* Tasks */}
      {tasksRunning > 0 && (
        <div className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="font-medium text-foreground">{tasksRunning}</span>
          <span>tasks</span>
        </div>
      )}
    </div>
  )
}

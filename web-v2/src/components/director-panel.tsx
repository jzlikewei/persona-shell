import { Brush, Eraser, Power, RotateCcw, Square } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useDirectorActions } from '@/hooks/use-director-actions'

interface DirectorPanelProps {
  /** 不传或 'main' = 主 director;其他值 = pool director label */
  directorLabel?: string
}

export function DirectorPanel({ directorLabel }: DirectorPanelProps) {
  const isMain = !directorLabel || directorLabel === 'main'
  const { flush, clear, interrupt, restart, shutdown, isBusy } = useDirectorActions({ directorLabel })

  return (
    <Tabs defaultValue="director" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="director">Director</TabsTrigger>
        <TabsTrigger value="session">Session</TabsTrigger>
      </TabsList>

      <TabsContent value="director">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono uppercase tracking-[.08em] text-muted-foreground">
              {isMain ? 'Main Director' : `Pool: ${directorLabel}`}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 pt-0">
            <Button variant="outline" size="sm" disabled={isBusy} onClick={() => flush()} title="刷新上下文">
              <Brush className="size-3.5" />
              Flush
            </Button>
            <Button variant="outline" size="sm" disabled={isBusy} onClick={() => restart()} title="重启当前 Session(保留对话历史)">
              <RotateCcw className="size-3.5" />
              Session Restart
            </Button>
            <Button variant="outline" size="sm" disabled={isBusy} onClick={() => interrupt()} title="中断当前 turn">
              <Square className="size-3.5" />
              Interrupt
            </Button>
            <Button variant="outline" size="sm" disabled={isBusy} onClick={() => clear()} title="清空上下文">
              <Eraser className="size-3.5" />
              Clear
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="session">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-mono uppercase tracking-[.08em] text-muted-foreground">
              当前 Session
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            {!isMain && (
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => shutdown()}
                title="关闭 Director 进程(main 不可用)"
              >
                <Power className="size-3.5" />
                Shutdown Director
              </Button>
            )}
            <p className="text-xs text-muted-foreground">暂无 session 级别操作</p>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

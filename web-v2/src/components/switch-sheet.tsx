import { Bot, Check, Loader2, UserCircle } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAgents, type AgentProvider } from '@/hooks/use-agents'
import { usePersonaRoles, type PersonaRole } from '@/hooks/use-persona-roles'
import { useStatus } from '@/hooks/use-status'
import { useDirectorActions } from '@/hooks/use-director-actions'
import { cn } from '@/lib/utils'

interface SwitchSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 默认 'main' */
  directorLabel?: string
}

export function SwitchSheet({ open, onOpenChange, directorLabel = 'main' }: SwitchSheetProps) {
  const status = useStatus()
  const currentAgent = status?.system?.directorAgentName
  const currentPersona = status?.system?.personaRole

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>切换 Agent / Persona</SheetTitle>
          <SheetDescription>
            为 {directorLabel === 'main' ? '主' : directorLabel} Director 选择 Agent 后端或 Persona 角色
          </SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="agent" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="agent">
              <Bot className="size-3.5" />
              Agent
            </TabsTrigger>
            <TabsTrigger value="persona">
              <UserCircle className="size-3.5" />
              Persona
            </TabsTrigger>
          </TabsList>
          <TabsContent value="agent" className="min-h-0 flex-1 overflow-y-auto">
            <AgentList currentAgent={currentAgent} directorLabel={directorLabel} onSwitched={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="persona" className="min-h-0 flex-1 overflow-y-auto">
            <PersonaList currentPersona={currentPersona} directorLabel={directorLabel} onSwitched={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function AgentList({
  currentAgent,
  directorLabel,
  onSwitched,
}: {
  currentAgent?: string
  directorLabel: string
  onSwitched: () => void
}) {
  const { agents, loading } = useAgents()
  const { switchAgent, isBusy } = useDirectorActions({ directorLabel })

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        加载中...
      </div>
    )
  }
  const entries = Object.entries(agents)
  if (entries.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">没有可用的 agent</div>
  }
  return (
    <div className="space-y-2 p-1">
      {entries.map(([name, agent]) => (
        <AgentCard
          key={name}
          name={name}
          agent={agent}
          isCurrent={name === currentAgent}
          disabled={isBusy}
          onSwitch={async () => {
            await switchAgent(name)
            onSwitched()
          }}
        />
      ))}
    </div>
  )
}

function AgentCard({
  name,
  agent,
  isCurrent,
  disabled,
  onSwitch,
}: {
  name: string
  agent: AgentProvider
  isCurrent: boolean
  disabled: boolean
  onSwitch: () => void
}) {
  return (
    <Card className={cn(isCurrent && 'border-primary')}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold">{name}</CardTitle>
        {isCurrent && (
          <Badge variant="secondary" className="gap-1">
            <Check className="size-3" />
            当前
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-xs text-muted-foreground">
        <div>
          type: <code className="text-foreground">{agent.type}</code>
        </div>
        {agent.model && (
          <div>
            model: <code className="text-foreground">{agent.model}</code>
          </div>
        )}
        <Button size="sm" className="mt-2 w-full" disabled={isCurrent || disabled} onClick={onSwitch}>
          {isCurrent ? '当前使用' : '切换到此'}
        </Button>
      </CardContent>
    </Card>
  )
}

function PersonaList({
  currentPersona,
  directorLabel,
  onSwitched,
}: {
  currentPersona?: string
  directorLabel: string
  onSwitched: () => void
}) {
  const { roles, loading } = usePersonaRoles()
  const { switchPersona, isBusy } = useDirectorActions({ directorLabel })

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        加载中...
      </div>
    )
  }
  if (roles.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">没有可用的 persona</div>
  }
  return (
    <div className="space-y-2 p-1">
      {roles.map(role => (
        <PersonaCard
          key={role.role}
          role={role}
          isCurrent={role.role === currentPersona}
          disabled={isBusy}
          onSwitch={async () => {
            await switchPersona(role.role)
            onSwitched()
          }}
        />
      ))}
    </div>
  )
}

function PersonaCard({
  role,
  isCurrent,
  disabled,
  onSwitch,
}: {
  role: PersonaRole
  isCurrent: boolean
  disabled: boolean
  onSwitch: () => void
}) {
  return (
    <Card className={cn(isCurrent && 'border-primary')}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-semibold">{role.name || role.role}</CardTitle>
        {isCurrent && (
          <Badge variant="secondary" className="gap-1">
            <Check className="size-3" />
            当前
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-xs text-muted-foreground">
        <div>
          role: <code className="text-foreground">{role.role}</code>
        </div>
        {role.description && <p className="text-foreground/80">{role.description}</p>}
        <Button size="sm" className="mt-2 w-full" disabled={isCurrent || disabled} onClick={onSwitch}>
          {isCurrent ? '当前使用' : '切换到此'}
        </Button>
      </CardContent>
    </Card>
  )
}

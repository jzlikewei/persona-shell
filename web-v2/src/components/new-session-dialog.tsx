import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAgents } from '@/hooks/use-agents'

interface NewSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: string
  defaultAgent?: string
  onCreate: (opts: { agent?: string; sessionName?: string; model?: string }) => void | Promise<void>
}

export function NewSessionDialog({ open, onOpenChange, workspace, defaultAgent, onCreate }: NewSessionDialogProps) {
  const [busy, setBusy] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(defaultAgent)
  const [modelInput, setModelInput] = useState('')
  const [customModelMode, setCustomModelMode] = useState(false)
  const { agents } = useAgents()
  const agentNames = Object.keys(agents)
  const currentAgent = selectedAgent ? agents[selectedAgent] : undefined
  const supportedModels = currentAgent?.supportedModels ?? []

  useEffect(() => {
    if (open) {
      setSessionName('')
      setSelectedAgent(defaultAgent)
      setModelInput('')
      setCustomModelMode(false)
    }
  }, [open, defaultAgent])

  // Reset model when agent changes
  useEffect(() => {
    setModelInput('')
    setCustomModelMode(false)
  }, [selectedAgent])

  if (!open) return null

  const modelValue = modelInput.trim() || undefined

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-card-foreground">新建 Session</h2>
        <p className="mt-1 text-sm text-muted-foreground">在 <span className="font-mono text-primary">{workspace}</span> 下创建新 session。</p>

        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Session 名称</label>
            <Input
              placeholder="可选，留空自动生成"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  document.getElementById('new-session-create-btn')?.click()
                }
              }}
              autoFocus
            />
          </div>

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

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            {supportedModels.length > 0 && !customModelMode ? (
              <select
                value={modelInput}
                onChange={e => {
                  if (e.target.value === '__custom__') {
                    setCustomModelMode(true)
                    setModelInput('')
                  } else {
                    setModelInput(e.target.value)
                  }
                }}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="">默认{currentAgent?.model ? ` (${currentAgent.model})` : ''}</option>
                {supportedModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="__custom__">自定义...</option>
              </select>
            ) : (
              <div className="flex gap-2">
                <Input
                  placeholder={currentAgent?.model ? `默认: ${currentAgent.model}` : '输入 model 名称'}
                  value={modelInput}
                  onChange={e => setModelInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      document.getElementById('new-session-create-btn')?.click()
                    }
                  }}
                />
                {supportedModels.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => { setCustomModelMode(false); setModelInput('') }}
                  >
                    列表
                  </Button>
                )}
              </div>
            )}
            {modelValue && !supportedModels.includes(modelValue) && (
              <p className="text-xs text-muted-foreground">新 model，将自动保存到配置</p>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            id="new-session-create-btn"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onCreate({
                  agent: selectedAgent,
                  sessionName: sessionName.trim() || undefined,
                  model: modelValue,
                })
              } finally {
                setBusy(false)
                onOpenChange(false)
              }
            }}
          >
            {busy ? '创建中...' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}

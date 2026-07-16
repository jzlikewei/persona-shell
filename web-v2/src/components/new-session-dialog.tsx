import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAgents, type CodexModelCatalogEntry } from '@/hooks/use-agents'

interface NewSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace: string
  defaultAgent?: string
  onCreate: (opts: { agent?: string; sessionName?: string; model?: string; reasoningEffort?: string }) => void | Promise<void>
}

export function NewSessionDialog({ open, onOpenChange, workspace, defaultAgent, onCreate }: NewSessionDialogProps) {
  const [busy, setBusy] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(defaultAgent)
  const [modelInput, setModelInput] = useState('')
  const [effortInput, setEffortInput] = useState('')
  const [customModelMode, setCustomModelMode] = useState(false)
  const [codexModels, setCodexModels] = useState<CodexModelCatalogEntry[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const { agents, defaultAgent: configuredDefaultAgent, reloadCodexModels } = useAgents()
  const agentNames = Object.keys(agents)
  const effectiveAgentName = selectedAgent || configuredDefaultAgent
  const currentAgent = effectiveAgentName ? agents[effectiveAgentName] : undefined
  const isCodex = currentAgent?.type === 'codex-app-server'
  const configuredModels = currentAgent?.supportedModels ?? []
  const supportedModels = isCodex ? codexModels.map(entry => entry.model) : configuredModels
  const selectedModelEntry = useMemo(() => {
    if (!isCodex || !modelInput.trim()) return undefined
    return codexModels.find(entry => entry.model === modelInput.trim())
  }, [codexModels, isCodex, modelInput])

  useEffect(() => {
    if (open) {
      setSessionName('')
      setSelectedAgent(defaultAgent)
      setModelInput('')
      setEffortInput('')
      setCustomModelMode(false)
      setCatalogError(null)
    }
  }, [open, defaultAgent])

  useEffect(() => {
    setModelInput('')
    setEffortInput('')
    setCustomModelMode(false)
    setCodexModels([])
    setCatalogError(null)
    if (!open || !effectiveAgentName || agents[effectiveAgentName]?.type !== 'codex-app-server') return
    let cancelled = false
    void reloadCodexModels(effectiveAgentName)
      .then(models => { if (!cancelled) setCodexModels(models) })
      .catch(error => { if (!cancelled) setCatalogError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [agents, effectiveAgentName, open, reloadCodexModels])

  useEffect(() => {
    setEffortInput(selectedModelEntry?.defaultReasoningEffort ?? '')
  }, [selectedModelEntry])

  if (!open) return null

  const modelValue = modelInput.trim() || undefined
  const effortValue = isCodex && modelValue ? effortInput.trim() || selectedModelEntry?.defaultReasoningEffort : undefined

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => onOpenChange(false)}>
      <div className="w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-card-foreground">新建 Session</h2>
        <p className="mt-1 text-sm text-muted-foreground">在 <span className="font-mono text-primary">{workspace}</span> 下创建新 session。</p>

        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Session 名称</label>
            <Input placeholder="可选，留空自动生成" value={sessionName} onChange={e => setSessionName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('new-session-create-btn')?.click() } }} autoFocus />
          </div>

          {agentNames.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Agent</label>
              <select value={selectedAgent ?? ''} onChange={e => setSelectedAgent(e.target.value || undefined)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <option value="">默认</option>
                {agentNames.map(name => <option key={name} value={name}>{name} ({agents[name].type}{agents[name].model ? ` · ${agents[name].model}` : ''})</option>)}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            {supportedModels.length > 0 && !customModelMode ? (
              <select value={modelInput} onChange={e => { if (e.target.value === '__custom__') { setCustomModelMode(true); setModelInput('') } else setModelInput(e.target.value) }} className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <option value="">默认{isCodex ? (codexModels.find(entry => entry.isDefault)?.displayName ? ` (${codexModels.find(entry => entry.isDefault)?.displayName})` : '') : currentAgent?.model ? ` (${currentAgent.model})` : ''}</option>
                {isCodex
                  ? codexModels.map(entry => <option key={entry.model} value={entry.model}>{entry.displayName ?? entry.model}</option>)
                  : configuredModels.map(model => <option key={model} value={model}>{model}</option>)}
                {!isCodex && <option value="__custom__">自定义...</option>}
              </select>
            ) : (
              <div className="flex gap-2">
                <Input placeholder={currentAgent?.model ? `默认: ${currentAgent.model}` : '输入 model 名称'} value={modelInput} onChange={e => setModelInput(e.target.value)} />
                {configuredModels.length > 0 && !isCodex && <Button variant="outline" size="sm" className="shrink-0" onClick={() => { setCustomModelMode(false); setModelInput('') }}>列表</Button>}
              </div>
            )}
            {catalogError && <p className="text-xs text-destructive">{catalogError}</p>}
            {!isCodex && modelValue && !configuredModels.includes(modelValue) && <p className="text-xs text-muted-foreground">新 model，将自动保存到配置</p>}
          </div>

          {isCodex && selectedModelEntry && selectedModelEntry.supportedReasoningEfforts.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Effort</label>
              <select value={effortInput || selectedModelEntry.defaultReasoningEffort || ''} onChange={e => setEffortInput(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
                {selectedModelEntry.supportedReasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button id="new-session-create-btn" size="sm" disabled={busy || Boolean(catalogError)} onClick={async () => {
            setBusy(true)
            try {
              await onCreate({ agent: selectedAgent, sessionName: sessionName.trim() || undefined, model: modelValue, reasoningEffort: effortValue })
            } finally {
              setBusy(false)
              onOpenChange(false)
            }
          }}>{busy ? '创建中...' : '创建'}</Button>
        </div>
      </div>
    </div>
  )
}

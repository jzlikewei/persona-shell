import { useCallback, useEffect, useState } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'
import { useToast } from '@/components/toast'

export interface AgentProvider {
  type: string
  command?: string
  model?: string | null
  sandbox?: string | null
  approval?: string | null
  effort?: string | null
  mcpMode?: string | null
  search?: boolean
  bare?: boolean
  dangerouslySkipPermissions?: boolean
  disableAutoFlush?: boolean
  systemPromptFile?: string | null
  agentFile?: string | null
  skillsDir?: string | null
  cwd?: string | null
}

interface ConfigSummary {
  agents: {
    providers: Record<string, AgentProvider>
  }
}

// 从 /api/config-summary 拿 agents.providers;context_update 事件时刷新
export function useAgents() {
  const { get } = useApi()
  const { on } = useWebSocket()
  const { toast } = useToast()
  const [agents, setAgents] = useState<Record<string, AgentProvider>>({})
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const res = await get<ConfigSummary>('/api/config-summary')
      setAgents(res.agents.providers)
    } catch (e) {
      console.error('useAgents: failed to load config-summary:', e)
      toast({ title: '加载 Agent 配置失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      setLoading(false)
    }
  }, [get, toast])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    return on('context_update', () => { reload() })
  }, [on, reload])

  return { agents, loading, reload }
}

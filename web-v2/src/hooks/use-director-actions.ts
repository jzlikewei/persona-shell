import { useCallback, useState } from 'react'
import { useApi } from './use-api'
import { useToast } from '@/components/toast'

export interface DirectorActionInput {
  /** 默认 'main'。其他值会被当成 pool director label 走 /api/directors/command。 */
  directorLabel?: string
}

export interface DirectorActionsApi {
  flush: () => Promise<void>
  clear: () => Promise<void>
  interrupt: () => Promise<void>
  restart: () => Promise<void>
  /** 关闭 Director 进程(只能用于 pool director,main 拒绝) */
  shutdown: () => Promise<void>
  switchAgent: (agent: string) => Promise<void>
  switchPersona: (role: string) => Promise<void>
  isBusy: boolean
}

interface CommandResponse {
  ok: boolean
  message?: string
  error?: string
}

export function useDirectorActions(input: DirectorActionInput = {}): DirectorActionsApi {
  const { directorLabel = 'main' } = input
  const { post } = useApi()
  const { toast } = useToast()
  const [isBusy, setIsBusy] = useState(false)
  const isMain = directorLabel === 'main'

  // 通用包装:跑 runner,把结果/异常转成 toast;返回 void 让 UI 不必 await 处理。
  const runCommand = useCallback(
    async (label: string, successMsg: string, runner: () => Promise<CommandResponse>) => {
      setIsBusy(true)
      try {
        const res = await runner()
        if (res?.ok === false || res?.error) {
          toast({ title: `${label} 失败`, description: res.message || res.error, tone: 'error' })
          return
        }
        toast({ title: successMsg, tone: 'success' })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        toast({ title: `${label} 失败`, description: message, tone: 'error' })
      } finally {
        setIsBusy(false)
      }
    },
    [toast]
  )

  // 主 director 走直连端点;pool director 走 /api/directors/command {director_label, command}
  const flush = useCallback(
    () =>
      runCommand('Flush', 'Flush 完成', () =>
        isMain
          ? post<CommandResponse>('/api/flush')
          : post<CommandResponse>('/api/directors/command', { director_label: directorLabel, command: 'flush' })
      ),
    [runCommand, isMain, directorLabel, post]
  )

  const clear = useCallback(
    () =>
      runCommand('Clear', 'Clear 完成', () =>
        isMain
          ? post<CommandResponse>('/api/clear')
          : post<CommandResponse>('/api/directors/command', { director_label: directorLabel, command: 'clear' })
      ),
    [runCommand, isMain, directorLabel, post]
  )

  const interrupt = useCallback(
    () =>
      runCommand('Interrupt', '已中断', () =>
        isMain
          ? post<CommandResponse>('/api/esc')
          : post<CommandResponse>('/api/directors/command', { director_label: directorLabel, command: 'esc' })
      ),
    [runCommand, isMain, directorLabel, post]
  )

  const restart = useCallback(
    () =>
      runCommand('Restart', 'Director 已重启', () =>
        isMain
          ? post<CommandResponse>('/api/session-restart')
          : post<CommandResponse>('/api/directors/command', { director_label: directorLabel, command: 'session-restart' })
      ),
    [runCommand, isMain, directorLabel, post]
  )

  const shutdown = useCallback(
    () =>
      runCommand('Shutdown', 'Director 已关闭', () =>
        // 端点本身对 main 返回 400,UI 在 DirectorPanel 隐藏按钮,所以理论上只会对 pool 调用
        post<CommandResponse>('/api/directors/shutdown', { director_label: directorLabel })
      ),
    [runCommand, directorLabel, post]
  )

  const switchAgent = useCallback(
    (agent: string) =>
      runCommand(
        'Switch agent',
        `Agent 已切换: ${agent}`,
        () => post<CommandResponse>('/api/directors/switch-agent', { director_label: directorLabel, agent })
      ),
    [runCommand, directorLabel, post]
  )

  const switchPersona = useCallback(
    (role: string) =>
      runCommand(
        'Switch persona',
        `Persona 已切换: ${role}`,
        () => post<CommandResponse>('/api/directors/switch-persona', { director_label: directorLabel, role })
      ),
    [runCommand, directorLabel, post]
  )

  return { flush, clear, interrupt, restart, shutdown, switchAgent, switchPersona, isBusy }
}

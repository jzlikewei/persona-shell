import { useCallback, useEffect, useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useToast } from '@/components/toast'
import { config } from '@/lib/config'

const RESTART_POLL_INTERVAL_MS = 10_000
const RESTART_POLL_INTERVAL_SECONDS = RESTART_POLL_INTERVAL_MS / 1000

/**
 * 侧边栏底部的"重启 Shell"快捷按钮。
 *
 * 行为:走 `POST /api/shell/restart`,
 * 走 shell-restart.ts 路径:detaching pool Directors + shutdown main Director +
 * 退出 Shell 进程(由守护进程重新拉起)。这是**硬重启**——session 状态、内存、
 * 子进程全清,跟 `/api/session-restart`(只重启 session 内部 thread)完全不同。
 *
 * 背景:Director 操作整合到面板后,原版 "Restart Shell"
 * 误替换成 session-restart,功能差远了。本组件恢复原行为,并加在 Tabs 之上
 * 作为独立可见的入口。
 */
export function RestartShellButton() {
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [nextPollIn, setNextPollIn] = useState(RESTART_POLL_INTERVAL_SECONDS)
  const [pollAttempts, setPollAttempts] = useState(0)
  const [pollMessage, setPollMessage] = useState('Shell 正在重启，等待进程恢复')

  const probeShellReady = useCallback(async () => {
    const token = localStorage.getItem('auth_token') || ''
    const headers = new Headers()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(new URL('/api/config-summary', config.apiBase), {
      method: 'GET',
      headers,
      cache: 'no-store',
    })
    if (res.status === 401) {
      localStorage.removeItem('auth_token')
      localStorage.removeItem('persona-shell:v2:auth-skip')
      window.location.reload()
      return false
    }
    return res.ok
  }, [])

  useEffect(() => {
    if (!restarting) return

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const countdownTimer = window.setInterval(() => {
      setNextPollIn(value => value > 1 ? value - 1 : RESTART_POLL_INTERVAL_SECONDS)
    }, 1000)

    const poll = async () => {
      if (cancelled) return
      setPollAttempts(value => value + 1)
      setPollMessage('正在检查 Shell 是否已经恢复')
      setNextPollIn(RESTART_POLL_INTERVAL_SECONDS)
      try {
        const ready = await probeShellReady()
        if (cancelled) return
        if (ready) {
          setPollMessage('Shell 已恢复，正在刷新页面')
          window.setTimeout(() => window.location.reload(), 500)
          return
        }
      } catch {
        // Shell 重启过程中 API 会短暂不可达，这是预期行为；继续轮询。
      }
      if (!cancelled) {
        setPollMessage('Shell 仍在重启，继续等待')
        pollTimer = window.setTimeout(poll, RESTART_POLL_INTERVAL_MS)
      }
    }

    setNextPollIn(RESTART_POLL_INTERVAL_SECONDS)
    setPollAttempts(0)
    setPollMessage('Shell 正在重启，等待进程恢复')
    pollTimer = window.setTimeout(poll, RESTART_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(countdownTimer)
      if (pollTimer) window.clearTimeout(pollTimer)
    }
  }, [probeShellReady, restarting])

  const handleConfirm = async () => {
    setConfirming(false)
    setPending(true)
    setPollMessage('正在发送 Shell 重启请求')
    try {
      const token = localStorage.getItem('auth_token') || ''
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const restartRes = await fetch(new URL('/api/shell/restart', config.apiBase), {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      })
      const res = await restartRes.json() as { ok: boolean; message?: string }
      if (!res.ok) {
        toast({ title: 'Shell 重启失败', description: res.message, tone: 'error' })
      } else {
        setRestarting(true)
        toast({ title: 'Shell 正在重启', description: '进程已退出，几秒后自动恢复', tone: 'info' })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      toast({ title: 'Shell 重启请求失败', description: message, tone: 'error' })
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      {(pending || restarting) && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[#11111b]/80 px-4 backdrop-blur-sm"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="w-full max-w-sm rounded-xl border border-[#45475a] bg-[#1e1e2e] p-5 text-center shadow-2xl shadow-black/40">
            <div className="mx-auto flex size-11 items-center justify-center rounded-full border border-[#585b70] bg-[#313244]">
              <Loader2 className="size-5 animate-spin text-[#89b4fa]" />
            </div>
            <div className="mt-4 text-sm font-bold text-[#cdd6f4]">
              {restarting ? 'Shell 正在重启' : '正在提交重启请求'}
            </div>
            <div className="mt-2 text-xs leading-5 text-[#a6adc8]">{pollMessage}</div>
            {restarting && (
              <div className="mt-4 rounded-lg border border-[#313244] bg-[#181825] px-3 py-2 font-mono text-[11px] text-[#7f849c]">
                每 10 秒自动检查一次
                <span className="mx-1 text-[#45475a]">·</span>
                下次检查 {nextPollIn}s
                <span className="mx-1 text-[#45475a]">·</span>
                第 {pollAttempts} 次
              </div>
            )}
          </div>
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={pending || restarting}
        onClick={() => setConfirming(true)}
        className="mb-2 w-full justify-center"
        title="重启整个 Shell 进程（所有 Director 关闭后重启）"
      >
        {pending || restarting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        {restarting ? 'Restarting...' : 'Restart Shell'}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="重启 Shell"
        description="将关闭所有 Director 并重启 Shell 进程。正在处理的消息会中断，已有 session 和状态会自动恢复。"
        confirmLabel="重启"
        destructive
        onConfirm={handleConfirm}
      />
    </>
  )
}

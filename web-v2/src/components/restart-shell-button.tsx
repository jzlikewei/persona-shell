import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useApi } from '@/hooks/use-api'
import { useToast } from '@/components/toast'

/**
 * 侧边栏底部的"重启 Shell"快捷按钮。
 *
 * 行为:走 `POST /api/send { text: '/shell-restart' }`,被 console.ts:2819 拦截,
 * 走 shell-restart.ts 路径:detaching pool Directors + shutdown main Director +
 * 退出 Shell 进程(由守护进程重新拉起)。这是**硬重启**——session 状态、内存、
 * 子进程全清,跟 `/api/session-restart`(只重启 session 内部 thread)完全不同。
 *
 * 背景:Director 操作整合到面板后,原版 "Restart Shell"
 * 误替换成 session-restart,功能差远了。本组件恢复原行为,并加在 Tabs 之上
 * 作为独立可见的入口。
 */
export function RestartShellButton() {
  const { post } = useApi()
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

  const handleConfirm = async () => {
    setConfirming(false)
    setPending(true)
    try {
      const res = await post<{ ok: boolean; message?: string }>('/api/send', { text: '/shell-restart' })
      if (!res.ok) {
        toast({ title: 'Shell 重启失败', description: res.message, tone: 'error' })
      } else {
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
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setConfirming(true)}
        className="mb-2 w-full justify-center"
        title="重启整个 Shell 进程（所有 Director 关闭后重启）"
      >
        <RotateCcw className="size-3.5" />
        Restart Shell
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

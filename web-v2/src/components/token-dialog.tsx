import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { KeyRound } from 'lucide-react'

export function TokenDialog({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('auth_token')
    if (stored) {
      onAuthenticated()
    } else {
      setVisible(true)
    }
  }, [onAuthenticated])

  const tryConnect = async (authToken: string | undefined) => {
    setChecking(true)
    setError(null)
    try {
      const headers: Record<string, string> = {}
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`
      const res = await fetch('/api/config-summary', { headers })
      if (!res.ok) {
        setError(`认证失败 (${res.status})`)
        setChecking(false)
        return
      }
      if (authToken) localStorage.setItem('auth_token', authToken)
      setVisible(false)
      onAuthenticated()
    } catch {
      setError('无法连接到服务器')
    } finally {
      setChecking(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    tryConnect(token.trim() || undefined)
  }

  const handleSkip = () => {
    tryConnect(undefined)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Authentication</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Enter your access token to connect to persona-shell.
        </p>
        <Input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Enter token..."
          autoFocus
          className="mb-4"
        />
        {error && (
          <p className="text-sm text-destructive mb-4">{error}</p>
        )}
        <Button type="submit" className="w-full" disabled={checking}>
          {checking ? 'Connecting...' : 'Connect'}
        </Button>
        <Button type="button" variant="ghost" className="w-full mt-2 text-muted-foreground" onClick={handleSkip} disabled={checking}>
          Skip (no token)
        </Button>
      </form>
    </div>
  )
}

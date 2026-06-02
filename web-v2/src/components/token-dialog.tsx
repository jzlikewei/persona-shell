import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { KeyRound } from 'lucide-react'

export function TokenDialog({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('auth_token')
    if (stored) {
      onAuthenticated()
    } else {
      setVisible(true)
    }
  }, [onAuthenticated])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (token.trim()) {
      localStorage.setItem('auth_token', token.trim())
    }
    setVisible(false)
    onAuthenticated()
  }

  const handleSkip = () => {
    setVisible(false)
    onAuthenticated()
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
        <Button type="submit" className="w-full">
          Connect
        </Button>
        <Button type="button" variant="ghost" className="w-full mt-2 text-muted-foreground" onClick={handleSkip}>
          Skip (no token)
        </Button>
      </form>
    </div>
  )
}

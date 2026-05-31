import { useState, useCallback } from 'react'
import { Check, Copy } from 'lucide-react'

interface CodeBlockProps {
  children: string
  className?: string
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const language = className?.replace(/^language-/, '') || ''

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [children])

  return (
    <div className="relative group">
      {language && (
        <div className="absolute top-0 left-3 text-[10px] text-muted-foreground/60 select-none">
          {language}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1 rounded bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
        aria-label="Copy code"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      <pre className={className}>
        <code>{children}</code>
      </pre>
    </div>
  )
}

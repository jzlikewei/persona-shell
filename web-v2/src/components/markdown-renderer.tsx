import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CodeBlock } from './code-block'

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children)
  return ''
}

interface MarkdownRendererProps {
  content: string
  className?: string
}

// detect:false — 无 language-X className 的 inline code 不再自动猜语言(highlight.js 大头)
const REHYPE_HIGHLIGHT_OPTIONS = { detect: false, ignoreMissing: true } as const

// WP6: 重新启用 —— document-panel / tasks.tsx 仍依赖此组件。
// chat.tsx 内联了 MarkdownContent 走 Catppuccin hex 配色 + 文件路径点击,
// 这里的通用版使用 prose/shadcn 语义色,适合非 chat 场景(tasks 输出、文件预览)。
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={className ?? 'prose prose-sm prose-invert max-w-none [&_pre]:bg-background/50 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_code]:text-xs'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, REHYPE_HIGHLIGHT_OPTIONS]]}
        components={{
          a({ href, children, ...props }) {
            return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
          },
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children, ...props }) {
            const text = extractText(children)
            const isBlock = className?.includes('language-') ||
              text.includes('\n')
            if (isBlock) {
              return (
                <CodeBlock className={className}>
                  {text.replace(/\n$/, '')}
                </CodeBlock>
              )
            }
            return <code className={className} {...props}>{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

export interface ChatToolCall {
  id?: string
  name: string
  input?: string
  result?: string
  isError?: boolean
  timestamp?: number
  status?: 'running' | 'completed' | 'failed'
}

export function mergeChatToolCall(current: ChatToolCall[], tool: ChatToolCall, now = Date.now()) {
  const normalized: ChatToolCall = {
    ...tool,
    name: tool.name || 'tool',
    status: tool.status ?? (tool.result !== undefined || tool.isError !== undefined
      ? (tool.isError ? 'failed' : 'completed')
      : 'running'),
    timestamp: tool.timestamp ?? now,
  }
  const tools = [...current]
  let index = normalized.id ? tools.findIndex(item => item.id === normalized.id) : -1
  if (index < 0) {
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      const item = tools[i]
      if (item.name === normalized.name && item.status === 'running') {
        index = i
        break
      }
    }
  }
  if (index < 0) index = tools.findIndex(item => item.name === normalized.name && !item.input && !item.result)
  if (index >= 0) {
    tools[index] = { ...tools[index], ...normalized }
  } else {
    tools.push(normalized)
  }
  return tools
}

import { describe, expect, test } from 'bun:test'
import { mergeChatToolCall, type ChatToolCall } from '../src/hooks/chat-tools'

describe('mergeChatToolCall', () => {
  test('merges completed tool with an id into prior running placeholder by name', () => {
    const started: ChatToolCall = { name: 'Bash', status: 'running', timestamp: 1 }
    const completed: ChatToolCall = {
      id: 'tool-1',
      name: 'Bash',
      input: '{ "command": "pwd" }',
      result: '/tmp/workspace',
      isError: false,
      timestamp: 2,
    }

    const tools = mergeChatToolCall([started], completed, 3)

    expect(tools).toHaveLength(1)
    expect(tools[0]).toEqual({
      id: 'tool-1',
      name: 'Bash',
      input: '{ "command": "pwd" }',
      result: '/tmp/workspace',
      isError: false,
      timestamp: 2,
      status: 'completed',
    })
  })

  test('keeps distinct running tools when there is no matching name or id', () => {
    const tools = mergeChatToolCall(
      [{ id: 'read-1', name: 'Read', status: 'running', timestamp: 1 }],
      { name: 'Bash', status: 'running' },
      2,
    )

    expect(tools).toHaveLength(2)
    expect(tools[1]).toMatchObject({ name: 'Bash', status: 'running', timestamp: 2 })
  })
})

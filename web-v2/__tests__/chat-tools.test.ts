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

  // ── Edge cases ──

  test('merges tool without id by matching name + running status', () => {
    const current: ChatToolCall[] = [
      { name: 'Read', status: 'running', timestamp: 1 },
      { name: 'Bash', status: 'running', timestamp: 2 },
    ]
    // incoming tool has no id — should match the last running 'Bash' by name
    const incoming: ChatToolCall = {
      name: 'Bash',
      result: 'done',
      isError: false,
      timestamp: 3,
    }

    const tools = mergeChatToolCall(current, incoming, 3)

    expect(tools).toHaveLength(2)
    expect(tools[1]).toMatchObject({
      name: 'Bash',
      result: 'done',
      status: 'completed',
    })
    // the other tool stays untouched
    expect(tools[0]).toMatchObject({ name: 'Read', status: 'running' })
  })

  test('status is explicitly overridden: tool_completed sets status=completed over prior running', () => {
    const current: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'running', timestamp: 1 },
    ]
    const completed: ChatToolCall = {
      id: 'tool-1',
      name: 'Bash',
      result: 'ok',
      isError: false,
      status: 'completed',
      timestamp: 2,
    }

    const tools = mergeChatToolCall(current, completed, 2)

    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('completed')
    expect(tools[0].result).toBe('ok')
  })

  test('completed tool is not overwritten by a new running tool with a different id', () => {
    const current: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'completed', result: 'ok', timestamp: 1 },
    ]
    // a new running tool with different id for the same name
    const newRunning: ChatToolCall = {
      id: 'tool-2',
      name: 'Bash',
      status: 'running',
      timestamp: 2,
    }

    const tools = mergeChatToolCall(current, newRunning, 2)

    // should push as a new entry — the completed one stays intact
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ id: 'tool-1', status: 'completed', result: 'ok' })
    expect(tools[1]).toMatchObject({ id: 'tool-2', status: 'running' })
  })

  test('empty tools array + new tool pushes to list', () => {
    const tools = mergeChatToolCall([], { name: 'Read', status: 'running' }, 10)

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ name: 'Read', status: 'running', timestamp: 10 })
  })
})

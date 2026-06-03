/**
 * log-parser.ts — Director 日志解析
 *
 * 从 Director 的 input/output 日志中重建对话历史、session 列表和任务日志。
 * 供 Web 控制台 API 使用。
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { getLogDir } from './logger.js';

/** 从文件尾部读取最多 maxBytes 字节，返回完整行（丢弃首行截断部分） */
function readTail(filePath: string, maxBytes: number): string {
  if (!existsSync(filePath)) return '';
  const stat = statSync(filePath);
  if (stat.size === 0) return '';
  const readSize = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readSize);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, readSize, stat.size - readSize);
  } finally {
    closeSync(fd);
  }
  const raw = buf.toString('utf-8');
  // 如果不是从文件开头读的，丢弃第一个不完整行
  if (readSize < stat.size) {
    const firstNewline = raw.indexOf('\n');
    return firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
  }
  return raw;
}

const MAX_LOG_READ_BYTES = 2 * 1024 * 1024; // 2MB

export interface ConversationMessage {
  direction: 'in' | 'out';
  content: string;
  sessionId?: string;
  timestamp?: number;
  tools?: ConversationToolCall[];
  provider?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
}

export interface ConversationToolCall {
  id?: string;
  name: string;
  input?: string;
  result?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface SessionInfo {
  sessionId: string;
  sessionName?: string;
  alive?: boolean;
  messageCount: number;
  firstMessageAt?: string;
  lastMessageAt?: string;
}

/** Parsed log entry from task stdout */
export interface TaskLogEntry {
  line: number;
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'result' | 'thinking';
  content: string;
  meta?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function getCodexLiveThreadId(evt: Record<string, unknown>): string | undefined {
  const params = asRecord(evt.params);
  const result = asRecord(evt.result);
  const thread = asRecord(params.thread);
  const resultThread = asRecord(result.thread);
  const direct = params.threadId ?? result.threadId ?? thread.id ?? resultThread.id;
  return typeof direct === 'string' && direct.trim() ? direct : undefined;
}

function numericField(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) return raw;
  }
  return undefined;
}

function usageMeta(evt: Record<string, unknown>): Partial<ConversationMessage> {
  const usage = asRecord(evt.usage);
  const message = asRecord(evt.message);
  const messageUsage = asRecord(message.usage);
  const effectiveUsage = Object.keys(usage).length > 0 ? usage : messageUsage;
  const inputTokens = numericField(effectiveUsage, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const outputTokens = numericField(effectiveUsage, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  const totalTokens = numericField(effectiveUsage, 'total_tokens', 'totalTokens');
  return {
    provider: stringField(evt, 'provider', 'agent', 'agent_type', 'agentType'),
    model: stringField(evt, 'model'),
    durationMs: numericField(evt, 'duration_ms', 'durationMs'),
    costUsd: numericField(evt, 'cost_usd', 'costUsd', 'total_cost_usd', 'totalCostUsd'),
    tokens: totalTokens ?? (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined),
    inputTokens,
    outputTokens,
    numTurns: numericField(evt, 'num_turns', 'numTurns'),
  };
}

function stringifyPreview(value: unknown, maxLength = 900): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '…' : trimmed;
}

function extractToolResultText(value: unknown): string | undefined {
  if (typeof value === 'string') return stringifyPreview(value, 1200);
  if (!Array.isArray(value)) return stringifyPreview(value, 1200);
  const parts: string[] = [];
  for (const block of value) {
    const item = asRecord(block);
    if (typeof item.content === 'string') parts.push(item.content);
    else if (typeof item.text === 'string') parts.push(item.text);
  }
  return stringifyPreview(parts.join('\n'), 1200);
}

function cloneTools(tools: ConversationToolCall[]): ConversationToolCall[] | undefined {
  return tools.length ? tools.map((tool) => ({ ...tool })) : undefined;
}

function pushToolCall(tools: ConversationToolCall[], tool: ConversationToolCall | undefined): void {
  if (!tool) return;
  const existing = tool.id ? tools.find((item) => item.id === tool.id) : undefined;
  if (existing) {
    Object.assign(existing, tool);
    return;
  }
  tools.push(tool);
}

function upsertToolResult(tools: ConversationToolCall[], id: string | undefined, result: string | undefined, isError?: boolean, timestamp?: string): void {
  if (!id && !result) return;
  const tool = id ? tools.find((item) => item.id === id) : undefined;
  if (tool) {
    tool.result = result;
    tool.isError = !!isError;
    if (timestamp) tool.timestamp = new Date(timestamp).getTime();
    return;
  }
  tools.push({
    id,
    name: 'tool result',
    result,
    isError: !!isError,
    timestamp: timestamp ? new Date(timestamp).getTime() : undefined,
  });
}

function codexToolFromItem(item: Record<string, unknown>, timestamp?: string): ConversationToolCall | undefined {
  const type = stringField(item, 'type');
  if (type === 'commandExecution' || type === 'command_execution') {
    const command = stringField(item, 'command') ?? '';
    const cwd = stringField(item, 'cwd');
    const exitCode = item.exitCode ?? item.exit_code;
    const status = stringField(item, 'status');
    const output = stringField(item, 'aggregatedOutput', 'aggregated_output');
    const input = stringifyPreview({ command, ...(cwd ? { cwd } : {}) });
    const result = stringifyPreview({
      ...(status ? { status } : {}),
      ...(exitCode != null ? { exitCode } : {}),
      ...(output ? { output } : {}),
    }, 1200);
    return {
      id: stringField(item, 'id'),
      name: 'Bash',
      input,
      result,
      isError: typeof exitCode === 'number' ? exitCode !== 0 : status === 'failed',
      timestamp: timestampMs(timestamp),
    };
  }

  if (type === 'fileChange' || type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return {
      id: stringField(item, 'id'),
      name: 'File change',
      input: stringifyPreview(changes),
      result: stringifyPreview({ status: stringField(item, 'status') }),
      isError: stringField(item, 'status') === 'failed',
      timestamp: timestampMs(timestamp),
    };
  }

  return undefined;
}

function extractCodexLiveAgentTextFromItem(item: Record<string, unknown>): string {
  return item.type === 'agentMessage' && typeof item.text === 'string' ? item.text : '';
}

function extractCodexLiveAgentTextFromTurn(turn: Record<string, unknown>): string {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return items
    .map((item) => extractCodexLiveAgentTextFromItem(asRecord(item)))
    .filter(Boolean)
    .join('\n\n');
}

function extractCodexLiveToolsFromTurn(turn: Record<string, unknown>, timestamp?: string): ConversationToolCall[] {
  const items = Array.isArray(turn.items) ? turn.items : [];
  return items
    .map((item) => codexToolFromItem(asRecord(item), timestamp))
    .filter((tool): tool is ConversationToolCall => !!tool);
}

function readTailFromFiles(filePaths: string[]): string {
  return filePaths
    .slice()
    .sort()
    .map((filePath) => readTail(filePath, MAX_LOG_READ_BYTES))
    .filter(Boolean)
    .join('\n');
}

function eventTimestamp(evt: Record<string, unknown>): string | undefined {
  return stringField(evt, '_ts', 'timestamp');
}

function eventSessionId(evt: Record<string, unknown>): string | undefined {
  const direct = stringField(evt, 'session_id', 'thread_id');
  if (direct) return direct;
  return getCodexLiveThreadId(evt);
}

function timestampMs(ts?: string): number | undefined {
  if (!ts) return undefined;
  const parsed = new Date(ts).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function composeResultText(intermediate: string, finalResult: string): string {
  if (!intermediate) return finalResult;
  if (!finalResult) return intermediate;
  if (intermediate === finalResult) return intermediate;
  if (finalResult.startsWith(intermediate)) return finalResult;
  if (intermediate.startsWith(finalResult)) return intermediate;
  if (intermediate.endsWith(finalResult)) return intermediate;
  return intermediate + '\n\n---\n\n' + finalResult;
}

/** Parse director logs to reconstruct conversation messages */
export function parseConversationLog(inputLog: string, outputLog: string, limit: number, sessionFilter?: string): ConversationMessage[] {
  return parseConversationLogFiles([inputLog], [outputLog], limit, sessionFilter);
}

/** Parse multiple director log files, preserving cross-day session history. */
export function parseConversationLogFiles(inputLogs: string[], outputLogs: string[], limit: number, sessionFilter?: string): ConversationMessage[] {
  // Parse input log — new format has timestamp + director fields
  const inputs: Array<{ content: string; director?: string; timestamp?: string; sessionId?: string }> = [];
  try {
    const raw = readTailFromFiles(inputLogs);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt?.type === 'user' && evt.message?.content) {
          inputs.push({ content: evt.message.content, director: evt.director, timestamp: evt.timestamp || evt._ts, sessionId: evt.session_id });
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  // Parse output log — extract result events with response text + session_id + director + timestamp
  const outputs: Array<{ text: string; sessionId?: string; director?: string; timestamp?: string; tools?: ConversationToolCall[]; meta?: Partial<ConversationMessage> }> = [];
  const sessionMarkers: Array<{ director: string; sessionId: string; timestamp: string; ms: number }> = [];
  try {
    const raw = readTailFromFiles(outputLogs);
    let pendingText = '';
    let pendingTools: ConversationToolCall[] = [];
    let lastSessionId: string | undefined;
    let lastDirector: string | undefined;
    let codexTurnTimestamp: string | undefined;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt._director) lastDirector = evt._director;
        const evtRecord = asRecord(evt);
        const evtDirector = typeof evt._director === 'string' ? evt._director : lastDirector;
        const evtSession = eventSessionId(evtRecord);
        const evtTs = eventTimestamp(evtRecord);
        const evtMs = timestampMs(evtTs);
        if (evtDirector && evtSession && evtTs && evtMs !== undefined) {
          sessionMarkers.push({ director: evtDirector, sessionId: evtSession, timestamp: evtTs, ms: evtMs });
        }
        if (evt.type === 'assistant' && evt.message?.content) {
          const content = evt.message.content;
          if (typeof content === 'string') {
            pendingText += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              const item = asRecord(block);
              if (item.type === 'text' && typeof item.text === 'string') {
                pendingText += item.text;
              } else if (item.type === 'tool_use') {
                pendingTools.push({
                  id: typeof item.id === 'string' ? item.id : undefined,
                  name: typeof item.name === 'string' ? item.name : 'tool',
                  input: stringifyPreview(item.input),
                  timestamp: evt._ts ? new Date(evt._ts).getTime() : undefined,
                });
              }
            }
          }
        } else if (evt?.type === 'user' && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            const item = asRecord(block);
            if (item.type !== 'tool_result') continue;
            upsertToolResult(
              pendingTools,
              typeof item.tool_use_id === 'string' ? item.tool_use_id : undefined,
              extractToolResultText(item.content),
              !!item.is_error,
              evt._ts || evt.timestamp,
            );
          }
        } else if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
          lastSessionId = evt.session_id;
        } else if (evt.type === 'thread.started' && evt.thread_id) {
          lastSessionId = evt.thread_id;
        } else if (evt.type === 'item.completed') {
          const item = asRecord(evt.item);
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            pendingText += item.text;
          } else {
            pushToolCall(pendingTools, codexToolFromItem(item, evt._ts || evt.timestamp));
          }
        } else if (evt.type === 'turn.completed') {
          if (pendingText) {
            outputs.push({ text: pendingText, sessionId: lastSessionId, director: lastDirector, timestamp: evt._ts || codexTurnTimestamp, tools: cloneTools(pendingTools), meta: usageMeta(evt) });
          }
          pendingText = '';
          pendingTools = [];
          codexTurnTimestamp = evt._ts || evt.timestamp;
        } else if (evt.method === 'thread/started' || evt.method === 'thread/resumed') {
          lastSessionId = getCodexLiveThreadId(evt) ?? lastSessionId;
        } else if (evt.result?.thread || evt.result?.threadId) {
          lastSessionId = getCodexLiveThreadId(evt) ?? lastSessionId;
        } else if (evt.method === 'item/completed') {
          const params = asRecord(evt.params);
          lastSessionId = getCodexLiveThreadId(evt) ?? lastSessionId;
          const item = asRecord(params.item);
          const itemText = extractCodexLiveAgentTextFromItem(item);
          if (itemText) pendingText += itemText;
          pushToolCall(pendingTools, codexToolFromItem(item, evt._ts || evt.timestamp));
        } else if (evt.method === 'turn/completed') {
          const params = asRecord(evt.params);
          lastSessionId = getCodexLiveThreadId(evt) ?? lastSessionId;
          const turn = asRecord(params.turn);
          const turnText = extractCodexLiveAgentTextFromTurn(turn);
          for (const tool of extractCodexLiveToolsFromTurn(turn, evt._ts || evt.timestamp)) {
            pushToolCall(pendingTools, tool);
          }
          const responseText = pendingText || turnText;
          if (responseText) {
            outputs.push({ text: responseText, sessionId: lastSessionId, director: lastDirector, timestamp: evt._ts, tools: cloneTools(pendingTools), meta: usageMeta({ ...evt, ...asRecord(params.turn) }) });
          }
          pendingText = '';
          pendingTools = [];
        } else if (evt.type === 'result') {
          if (evt.session_id) lastSessionId = evt.session_id;
          const finalResult = typeof evt.result === 'string' ? evt.result.trim() : '';
          const intermediate = pendingText.trim();
          const resultText = composeResultText(intermediate, finalResult);
          if (resultText) {
            outputs.push({ text: resultText, sessionId: lastSessionId, director: lastDirector, timestamp: evt._ts, tools: cloneTools(pendingTools), meta: usageMeta(evt) });
          }
          pendingText = '';
          pendingTools = [];
        }
      } catch { /* skip malformed lines */ }
    }
    // flush pending text from in-progress (not yet completed) turns
    if (pendingText.trim()) {
      outputs.push({ text: pendingText, sessionId: lastSessionId, director: lastDirector, timestamp: undefined, tools: cloneTools(pendingTools) });
      pendingText = '';
      pendingTools = [];
    }
  } catch { /* file read error */ }

  const markersByDirector = new Map<string, Array<{ sessionId: string; timestamp: string; ms: number }>>();
  for (const marker of sessionMarkers) {
    const arr = markersByDirector.get(marker.director) ?? [];
    arr.push(marker);
    markersByDirector.set(marker.director, arr);
  }
  for (const markers of markersByDirector.values()) {
    markers.sort((a, b) => a.ms - b.ms);
  }

  function inferInputSessionId(input: { director?: string; timestamp?: string; sessionId?: string }): string | undefined {
    if (input.sessionId) return input.sessionId;
    const inputMs = timestampMs(input.timestamp);
    if (inputMs === undefined) return undefined;
    const markers = markersByDirector.get(input.director ?? 'main') ?? [];
    if (markers.length === 0) return undefined;

    let previous: { sessionId: string; ms: number } | undefined;
    let next: { sessionId: string; ms: number } | undefined;
    for (const marker of markers) {
      if (marker.ms <= inputMs) {
        previous = marker;
      } else {
        next = marker;
        break;
      }
    }

    if (next && (!previous || next.ms - inputMs < Math.min(inputMs - previous.ms, 120_000))) {
      return next.sessionId;
    }
    return previous?.sessionId ?? next?.sessionId;
  }

  // Per-director pairing: group inputs and outputs by director label, then pair within each group
  const directorInputs = new Map<string, Array<{ content: string; timestamp?: string; sessionId?: string }>>();
  const directorOutputs = new Map<string, Array<{ text: string; sessionId?: string; timestamp?: string; tools?: ConversationToolCall[]; meta?: Partial<ConversationMessage> }>>();

  for (const inp of inputs) {
    const key = inp.director ?? 'main';
    const arr = directorInputs.get(key) ?? [];
    arr.push({ content: inp.content, timestamp: inp.timestamp, sessionId: inferInputSessionId(inp) });
    directorInputs.set(key, arr);
  }

  for (const out of outputs) {
    const key = out.director ?? 'main';
    const arr = directorOutputs.get(key) ?? [];
    arr.push({ text: out.text, sessionId: out.sessionId, timestamp: out.timestamp, tools: out.tools, meta: out.meta });
    directorOutputs.set(key, arr);
  }

  // Pair within each director group using tail-aligned strategy
  const messages: ConversationMessage[] = [];
  const allDirectors = new Set([...directorInputs.keys(), ...directorOutputs.keys()]);

  for (const dir of allDirectors) {
    const ins = directorInputs.get(dir) ?? [];
    const outs = directorOutputs.get(dir) ?? [];
    const offset = Math.max(0, outs.length - ins.length);

    // Orphan outputs
    for (let i = 0; i < offset; i++) {
      const o = outs[i];
      if (sessionFilter && o.sessionId && o.sessionId !== sessionFilter) continue;
      messages.push({ direction: 'out', content: o.text, sessionId: o.sessionId, timestamp: o.timestamp ? new Date(o.timestamp!).getTime() : undefined, tools: o.tools, ...o.meta });
    }

    // Paired input/output
    for (let i = 0; i < ins.length; i++) {
      const oIdx = offset + i;
      const pairedOutput = oIdx < outs.length ? outs[oIdx] : undefined;
      const sessionId = ins[i].sessionId ?? pairedOutput?.sessionId;
      const includeInput = !sessionFilter || sessionId === sessionFilter;
      const includeOutput = !!pairedOutput && (!sessionFilter || pairedOutput.sessionId === sessionFilter);

      if (includeInput) {
        messages.push({ direction: 'in', content: ins[i].content, sessionId, timestamp: timestampMs(ins[i].timestamp) });
      }
      if (includeOutput && pairedOutput) {
        messages.push({ direction: 'out', content: pairedOutput.text, sessionId: pairedOutput.sessionId, timestamp: timestampMs(pairedOutput.timestamp), tools: pairedOutput.tools, ...pairedOutput.meta });
      }
    }
  }

  // Sort by timestamp when available (for multi-Director interleaving), then return tail
  messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return messages.slice(-limit).reverse();
}

/** Extract unique session IDs from director output log */
export function parseSessions(outputLog: string): SessionInfo[] {
  return parseSessionsFiles([outputLog]);
}

/** Extract unique session IDs from multiple director output logs. */
export function parseSessionsFiles(outputLogs: string[]): SessionInfo[] {
  const sessionMap = new Map<string, { count: number; first?: string; last?: string }>();

  try {
    const raw = readTailFromFiles(outputLogs);
    if (!raw.trim()) return [];
    let currentSession: string | undefined;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
          currentSession = evt.session_id;
        }
        if (evt.type === 'thread.started' && evt.thread_id) {
          currentSession = evt.thread_id;
        }
        if (evt.method === 'thread/started' || evt.method === 'thread/resumed' || evt.result?.thread || evt.result?.threadId) {
          currentSession = getCodexLiveThreadId(evt) ?? currentSession;
        }
        if (evt.type === 'result') {
          const sid = evt.session_id || currentSession;
          if (!sid) continue;
          currentSession = sid;

          const entry = sessionMap.get(sid) || { count: 0 };
          entry.count++;
          const timestamp = evt._ts || evt.timestamp || new Date().toISOString();
          if (!entry.first) entry.first = timestamp;
          entry.last = timestamp;
          sessionMap.set(sid, entry);
        }
        if (evt.type === 'turn.completed') {
          const sid = currentSession;
          if (!sid) continue;

          const entry = sessionMap.get(sid) || { count: 0 };
          entry.count++;
          const timestamp = evt._ts || evt.timestamp || new Date().toISOString();
          if (!entry.first) entry.first = timestamp;
          entry.last = timestamp;
          sessionMap.set(sid, entry);
        }
        if (evt.method === 'turn/completed') {
          const sid = getCodexLiveThreadId(evt) ?? currentSession;
          if (!sid) continue;
          currentSession = sid;

          const entry = sessionMap.get(sid) || { count: 0 };
          entry.count++;
          const timestamp = evt._ts || evt.timestamp || new Date().toISOString();
          if (!entry.first) entry.first = timestamp;
          entry.last = timestamp;
          sessionMap.set(sid, entry);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  return Array.from(sessionMap.entries()).map(([sessionId, info]) => ({
    sessionId,
    messageCount: info.count,
    firstMessageAt: info.first,
    lastMessageAt: info.last,
  })).sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}

/** Parse a task's stdout log into structured entries for the web console */
export function parseTaskLog(taskId: string, afterLine: number): { entries: TaskLogEntry[]; totalLines: number } {
  const logPath = join(getLogDir(), `task-${taskId}.stdout.log`);
  if (!existsSync(logPath)) return { entries: [], totalLines: 0 };

  let raw: string;
  try { raw = readFileSync(logPath, 'utf-8'); } catch { return { entries: [], totalLines: 0 }; }

  const allLines = raw.split('\n');
  const entries: TaskLogEntry[] = [];

  for (let i = afterLine; i < allLines.length; i++) {
    const lineText = allLines[i].trim();
    if (!lineText) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsing untyped external JSON
    let evt: any; // no-any-guard-ignore
    try { evt = JSON.parse(lineText); } catch { continue; }

    if (evt.type === 'system') {
      if (evt.subtype === 'init') {
        entries.push({ line: i, type: 'system', content: `Session: ${evt.session_id?.slice(0, 12) ?? '?'}`, meta: { session_id: evt.session_id } });
      }
      continue;
    }

    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text) {
          entries.push({ line: i, type: 'text', content: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          entries.push({ line: i, type: 'thinking', content: block.thinking });
        } else if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown> | undefined;
          const trimmed: Record<string, unknown> = {};
          if (input) {
            for (const [k, v] of Object.entries(input)) {
              trimmed[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
            }
          }
          entries.push({ line: i, type: 'tool_use', content: block.name ?? 'unknown', meta: { id: block.id, input: trimmed } });
        }
      }
      continue;
    }

    if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_result') {
          const rc = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          entries.push({ line: i, type: 'tool_result', content: rc.length > 500 ? rc.slice(0, 500) + '…' : rc, meta: { is_error: !!block.is_error } });
        }
      }
      continue;
    }

    if (evt.type === 'result') {
      entries.push({
        line: i, type: 'result',
        content: evt.subtype === 'success' ? 'Completed' : (evt.subtype ?? 'done'),
        meta: { duration_ms: evt.duration_ms, cost_usd: evt.total_cost_usd, num_turns: evt.num_turns },
      });
    }
  }

  return { entries, totalLines: allLines.length };
}

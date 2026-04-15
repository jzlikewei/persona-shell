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
}

export interface SessionInfo {
  sessionId: string;
  sessionName?: string;
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

/** Parse director logs to reconstruct conversation messages */
export function parseConversationLog(inputLog: string, outputLog: string, limit: number, sessionFilter?: string): ConversationMessage[] {
  // Parse input log — new format has timestamp + director fields
  const inputs: Array<{ content: string; director?: string; timestamp?: string }> = [];
  try {
    const raw = readTail(inputLog, MAX_LOG_READ_BYTES);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt?.type === 'user' && evt.message?.content) {
          inputs.push({ content: evt.message.content, director: evt.director, timestamp: evt.timestamp || evt._ts });
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  // Parse output log — extract result events with response text + session_id + director + timestamp
  const outputs: Array<{ text: string; sessionId?: string; director?: string; timestamp?: string }> = [];
  try {
    const raw = readTail(outputLog, MAX_LOG_READ_BYTES);
    let pendingText = '';
    let lastSessionId: string | undefined;
    let lastDirector: string | undefined;
    let codexTurnTimestamp: string | undefined;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt._director) lastDirector = evt._director;
        if (evt.type === 'assistant' && evt.message?.content) {
          const content = evt.message.content;
          if (typeof content === 'string') {
            pendingText += content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') pendingText += block.text;
            }
          }
        } else if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
          lastSessionId = evt.session_id;
        } else if (evt.type === 'thread.started' && evt.thread_id) {
          lastSessionId = evt.thread_id;
        } else if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
          pendingText += evt.item.text;
        } else if (evt.type === 'turn.completed') {
          if (pendingText) {
            outputs.push({ text: pendingText, sessionId: lastSessionId, director: lastDirector, timestamp: evt._ts || codexTurnTimestamp });
          }
          pendingText = '';
          codexTurnTimestamp = evt._ts || evt.timestamp;
        } else if (evt.type === 'result') {
          if (evt.session_id) lastSessionId = evt.session_id;
          const resultText = pendingText || (typeof evt.result === 'string' ? evt.result : '');
          if (resultText) {
            outputs.push({ text: resultText, sessionId: lastSessionId, director: lastDirector, timestamp: evt._ts });
          }
          pendingText = '';
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  // Per-director pairing: group inputs and outputs by director label, then pair within each group
  const directorInputs = new Map<string, Array<{ content: string; timestamp?: string }>>();
  const directorOutputs = new Map<string, Array<{ text: string; sessionId?: string; timestamp?: string }>>();

  for (const inp of inputs) {
    const key = inp.director ?? 'main';
    const arr = directorInputs.get(key) ?? [];
    arr.push({ content: inp.content, timestamp: inp.timestamp });
    directorInputs.set(key, arr);
  }

  for (const out of outputs) {
    const key = out.director ?? 'main';
    const arr = directorOutputs.get(key) ?? [];
    arr.push({ text: out.text, sessionId: out.sessionId, timestamp: out.timestamp });
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
      messages.push({ direction: 'out', content: o.text, sessionId: o.sessionId, timestamp: o.timestamp ? new Date(o.timestamp!).getTime() : undefined });
    }

    // Paired input/output
    for (let i = 0; i < ins.length; i++) {
      const oIdx = offset + i;
      const sessionId = oIdx < outs.length ? outs[oIdx].sessionId : undefined;
      if (sessionFilter && sessionId && sessionId !== sessionFilter) continue;

      messages.push({ direction: 'in', content: ins[i].content, sessionId, timestamp: ins[i].timestamp ? new Date(ins[i].timestamp!).getTime() : undefined });
      if (oIdx < outs.length) {
        messages.push({ direction: 'out', content: outs[oIdx].text, sessionId: outs[oIdx].sessionId, timestamp: outs[oIdx].timestamp ? new Date(outs[oIdx].timestamp!).getTime() : undefined });
      }
    }
  }

  // Sort by timestamp when available (for multi-Director interleaving), then return tail
  messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return messages.slice(-limit).reverse();
}

/** Extract unique session IDs from director output log */
export function parseSessions(outputLog: string): SessionInfo[] {
  const sessionMap = new Map<string, { count: number; first?: string; last?: string }>();

  if (!existsSync(outputLog)) return [];

  try {
    const raw = readTail(outputLog, MAX_LOG_READ_BYTES);
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

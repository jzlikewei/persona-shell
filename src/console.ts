import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join, resolve, extname } from 'path';
import { homedir } from 'os';

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
import type { Director } from './director.js';
import type { MessageQueue } from './queue.js';
import type { Config } from './config.js';
import type { TaskRunner } from './task-runner.js';
import { createTask, getTask, listTasks, cancelTask as cancelTaskInDb, type CreateTaskInput, createCronJob, getCronJob, listCronJobs, updateCronJob, deleteCronJob, toggleCronJob, type CreateCronJobInput } from './task-store.js';

/** Director log paths — must match director.ts */
const LOG_DIR = join(import.meta.dirname, '..', 'logs');
const INPUT_LOG = join(LOG_DIR, 'director-input.log');
const OUTPUT_LOG = join(LOG_DIR, 'director-output.log');

interface ConversationMessage {
  direction: 'in' | 'out';
  content: string;
  sessionId?: string;
  timestamp?: number;
}

interface SessionInfo {
  sessionId: string;
  messageCount: number;
  firstMessageAt?: string;
  lastMessageAt?: string;
}

/** Parse director logs to reconstruct conversation messages */
function parseConversationLog(limit: number, sessionFilter?: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];

  // Parse input log — each line is {"type":"user","message":{"role":"user","content":"..."}}
  const inputs: string[] = [];
  try {
    const raw = readTail(INPUT_LOG, MAX_LOG_READ_BYTES);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt?.type === 'user' && evt.message?.content) {
          inputs.push(evt.message.content);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file read error */ }

  // Parse output log — extract result events with response text + session_id
  // Only keep result events that have actual response text (skip intermediate tool-use results)
  const outputs: Array<{ text: string; sessionId?: string }> = [];
  try {
    const raw = readTail(OUTPUT_LOG, MAX_LOG_READ_BYTES);
    let pendingText = '';
    let lastSessionId: string | undefined;

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
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
          } else if (evt.type === 'result') {
            if (evt.session_id) lastSessionId = evt.session_id;
            const resultText = pendingText || (typeof evt.result === 'string' ? evt.result : '');
            // Only collect results with actual text — skip empty intermediate tool-use results
            if (resultText) {
              outputs.push({ text: resultText, sessionId: lastSessionId });
            }
            pendingText = '';
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file read error */ }

  // Tail-aligned pairing: most recent input corresponds to most recent output.
  // Output log may have started recording before input log, so early outputs are orphans.
  const outputOffset = Math.max(0, outputs.length - inputs.length);

  // Orphan outputs (no matching input)
  for (let i = 0; i < outputOffset; i++) {
    const o = outputs[i];
    if (sessionFilter && o.sessionId && o.sessionId !== sessionFilter) continue;
    messages.push({ direction: 'out', content: o.text, sessionId: o.sessionId });
  }

  // Paired input/output
  for (let i = 0; i < inputs.length; i++) {
    const oIdx = outputOffset + i;
    const sessionId = oIdx < outputs.length ? outputs[oIdx].sessionId : undefined;
    if (sessionFilter && sessionId && sessionId !== sessionFilter) continue;

    messages.push({ direction: 'in', content: inputs[i], sessionId });
    if (oIdx < outputs.length) {
      messages.push({ direction: 'out', content: outputs[oIdx].text, sessionId: outputs[oIdx].sessionId });
    }
  }

  // Return most recent first, limited
  return messages.slice(-limit).reverse();
}

/** Extract unique session IDs from director output log */
function parseSessions(): SessionInfo[] {
  const sessionMap = new Map<string, { count: number; first?: string; last?: string }>();

  if (!existsSync(OUTPUT_LOG)) return [];

  try {
    const raw = readTail(OUTPUT_LOG, MAX_LOG_READ_BYTES);
    let currentSession: string | undefined;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
          currentSession = evt.session_id;
        }
        if (evt.type === 'result') {
          const sid = evt.session_id || currentSession;
          if (!sid) continue;
          currentSession = sid;

          const entry = sessionMap.get(sid) || { count: 0 };
          entry.count++;
          const timestamp = new Date().toISOString(); // approximate
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

/** Parsed log entry from task stdout */
interface TaskLogEntry {
  line: number;
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'result' | 'thinking';
  content: string;
  meta?: Record<string, unknown>;
}

/** Parse a task's stdout log into structured entries for the web console */
function parseTaskLog(taskId: string, afterLine: number): { entries: TaskLogEntry[]; totalLines: number } {
  const logPath = join(LOG_DIR, `task-${taskId}.stdout.log`);
  if (!existsSync(logPath)) return { entries: [], totalLines: 0 };

  let raw: string;
  try { raw = readFileSync(logPath, 'utf-8'); } catch { return { entries: [], totalLines: 0 }; }

  const allLines = raw.split('\n');
  const entries: TaskLogEntry[] = [];

  for (let i = afterLine; i < allLines.length; i++) {
    const lineText = allLines[i].trim();
    if (!lineText) continue;

    let evt: any;
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

// Shell 启动时间，用于计算 uptime
const startedAt = Date.now();

/** Attachment compositor buffer — implemented in index.ts */
export interface AttachmentBuffer {
  /** Add a file path to the pending buffer */
  push(filePath: string): void;
  /** Whether Director is currently processing a user message (queue has items) */
  hasPending(): boolean;
}

/** Metrics collector interface — implemented in index.ts */
export interface MetricsCollector {
  recentMessages: Array<{ direction: 'in' | 'out'; preview: string; timestamp: number; responseSec?: number }>;
  recentErrors: Array<{ message: string; timestamp: number }>;
  today: { date: string; messagesProcessed: number; totalResponseMs: number; totalCostUsd: number };
  addMessage(msg: { direction: 'in' | 'out'; preview: string; timestamp: number; responseSec?: number }): void;
  addError(message: string): void;
  getToday(): { date: string; messagesProcessed: number; totalResponseMs: number; totalCostUsd: number };
}

/**
 * 启动 Web 管理控制台（HTTP + WebSocket）
 * 用 Bun.serve() 提供单页 TUI 前端 + 实时状态推送 + 命令接收
 */
export function startConsole(
  director: Director,
  queue: MessageQueue,
  config: Config,
  taskRunner?: TaskRunner,
  feishu?: {
    getConnectionStatus: () => 'connected' | 'disconnected';
    getLastChatId: () => string | null;
    uploadAndSendImage: (chatId: string, filePath: string) => Promise<string | null>;
    uploadAndReplyImage: (messageId: string, filePath: string) => Promise<void>;
    uploadAndSendFile: (chatId: string, filePath: string) => Promise<string | null>;
    uploadAndReplyFile: (messageId: string, filePath: string) => Promise<void>;
  },
  metrics?: MetricsCollector,
  attachmentBuffer?: AttachmentBuffer,
): void {
  if (!config.console.enabled) {
    console.log('[console] Web console disabled by config');
    return;
  }

  const port = config.console.port;
  const token = config.console.token;
  const htmlPath = join(import.meta.dir, 'public', 'index.html');

  /** 检查请求是否携带有效 token，未配置 token 时放行 */
  function checkAuth(req: Request): Response | null {
    if (!token) return null; // 未配置 token，放行
    const auth = req.headers.get('Authorization');
    if (auth === `Bearer ${token}`) return null;
    return new Response('Unauthorized', { status: 401 });
  }

  // 活跃的 WebSocket 连接集合
  const clients = new Set<any>();

  // 构建状态快照
  function buildSnapshot() {
    const ds = director.getStatus();
    const now = Date.now();

    // System status
    const feishuStatus = feishu?.getConnectionStatus() ?? 'disconnected';
    let systemStatus: 'healthy' | 'degraded' | 'error';
    if (feishuStatus === 'connected' && ds.alive) {
      systemStatus = 'healthy';
    } else if (feishuStatus === 'connected' || ds.alive) {
      systemStatus = 'degraded';
    } else {
      systemStatus = 'error';
    }

    // Activity
    const activity: Record<string, unknown> = { state: ds.activityState };
    if (ds.currentMessagePreview && ds.currentMessageStartedAt) {
      activity.currentMessage = {
        preview: ds.currentMessagePreview,
        elapsedMs: now - ds.currentMessageStartedAt,
      };
    }

    // Context — use contextWindow from modelUsage as denominator (falls back to flushContextLimit)
    const contextLimit = ds.contextWindow > 0 ? ds.contextWindow : ds.flushContextLimit;
    const tokenPercent = contextLimit > 0
      ? Math.round((ds.lastInputTokens / contextLimit) * 100)
      : 0;

    // Metrics
    const todayStats = metrics?.getToday() ?? { messagesProcessed: 0, totalResponseMs: 0, totalCostUsd: 0 };
    const avgResponseSec = todayStats.messagesProcessed > 0
      ? Math.round((todayStats.totalResponseMs / todayStats.messagesProcessed / 1000) * 10) / 10
      : 0;

    // Queue snapshot with preview field
    const queueSnapshot = queue.getSnapshot().map((item) => ({
      correlationId: item.correlationId,
      preview: item.text,
      timestamp: item.timestamp,
      cancelled: item.cancelled,
    }));

    // Tasks
    const allTasks = listTasks({ limit: 50 });
    const taskSummary = { running: 0, completed: 0, failed: 0 };
    for (const t of allTasks) {
      if (t.status === 'running' || t.status === 'dispatched') taskSummary.running++;
      else if (t.status === 'completed') taskSummary.completed++;
      else if (t.status === 'failed') taskSummary.failed++;
    }
    const recentTasks = allTasks.slice(0, 10).map((t) => ({
      id: t.id,
      role: t.role,
      description: t.description,
      status: t.status,
      createdAt: t.created_at,
      durationMs: t.duration_ms ?? undefined,
      costUsd: t.cost_usd ?? undefined,
    }));

    return {
      type: 'status' as const,
      data: {
        system: {
          status: systemStatus,
          uptime: now - startedAt,
          feishu: feishuStatus,
          directorAlive: ds.alive,
          sessionId: ds.sessionId,
        },
        activity,
        context: {
          tokens: ds.lastInputTokens,
          limit: contextLimit,
          percent: tokenPercent,
          lastFlushAgoMs: now - ds.lastFlushAt,
        },
        metrics: {
          today: {
            messagesProcessed: todayStats.messagesProcessed,
            avgResponseSec,
            totalCostUsd: todayStats.totalCostUsd + ds.totalCostUsd,
          },
          recentMessages: metrics?.recentMessages ?? [],
          recentErrors: metrics?.recentErrors ?? [],
        },
        queue: queueSnapshot,
        tasks: {
          summary: taskSummary,
          recent: recentTasks,
        },
      },
    };
  }

  // 处理客户端命令
  async function handleCommand(
    command: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      switch (command) {
        case 'flush': {
          const success = await director.flush();
          return {
            ok: success,
            message: success ? 'Flush 完成' : 'Flush 未能完成（超时或正在进行中）',
          };
        }
        case 'esc': {
          const cancelled = queue.cancelOldest();
          if (cancelled) {
            await director.interrupt();
            return { ok: true, message: `已取消: "${cancelled.text.slice(0, 30)}..."` };
          }
          return { ok: false, message: '队列为空，没有可取消的消息' };
        }
        case 'restart': {
          await director.restartDirector();
          return { ok: true, message: 'Director 已重启' };
        }
        default:
          return { ok: false, message: `未知命令: ${command}` };
      }
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  // 每秒向所有客户端推送状态
  const statusInterval = setInterval(() => {
    if (clients.size === 0) return;
    const snapshot = JSON.stringify(buildSnapshot());
    for (const ws of clients) {
      try {
        ws.send(snapshot);
      } catch {
        clients.delete(ws);
      }
    }
  }, 1000);

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req, server) {
      const url = new URL(req.url);

      // Token 认证检查
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      // WebSocket 升级
      if (server.upgrade(req)) {
        return undefined as unknown as Response;
      }

      // HTTP 路由
      switch (url.pathname) {
        case '/': {
          try {
            const html = readFileSync(htmlPath, 'utf-8');
            return new Response(html, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
          } catch (err) {
            return new Response('index.html not found', { status: 500 });
          }
        }
        default: {
          // POST /api/send — send arbitrary text to Director (bypass feishu)
          if (url.pathname === '/api/send' && req.method === 'POST') {
            const body = await req.json() as { text: string };
            if (!body.text) return Response.json({ ok: false, message: 'text is required' }, { status: 400 });
            try {
              await director.send(body.text);
              return Response.json({ ok: true, message: 'sent' });
            } catch (err) {
              return Response.json({ ok: false, message: String(err) }, { status: 500 });
            }
          }

          // POST /api/send-attachment — send image/file to user via feishu
          if (url.pathname === '/api/send-attachment' && req.method === 'POST') {
            const body = await req.json() as { path: string };
            if (!body.path) return Response.json({ error: 'path is required' }, { status: 400 });

            // Path security: only allow /tmp/ and ~/.persona/outbox/
            const resolved = resolve(body.path);
            const allowedPrefixes = ['/tmp/', resolve(homedir(), '.persona/outbox/')];
            if (!allowedPrefixes.some(prefix => resolved.startsWith(prefix))) {
              return Response.json({ error: `Path not allowed: ${resolved}` }, { status: 403 });
            }

            // File existence and size check
            if (!existsSync(resolved)) {
              return Response.json({ error: `File not found: ${resolved}` }, { status: 404 });
            }
            const stat = statSync(resolved);
            if (stat.size === 0) {
              return Response.json({ error: 'File is empty' }, { status: 400 });
            }

            if (!feishu) {
              return Response.json({ error: 'Feishu client not available' }, { status: 503 });
            }

            // Compositor: if Director is processing a user message, buffer for later delivery
            if (attachmentBuffer?.hasPending()) {
              attachmentBuffer.push(resolved);
              return Response.json({ queued: true });
            }

            // No pending response — send immediately as new message to lastChatId
            const ext = extname(resolved).toLowerCase();
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
            const isImage = imageExts.has(ext);

            try {
              const lastChatId = feishu.getLastChatId();
              if (!lastChatId) return Response.json({ error: 'No active chat to send to' }, { status: 400 });
              if (isImage) {
                await feishu.uploadAndSendImage(lastChatId, resolved);
              } else {
                await feishu.uploadAndSendFile(lastChatId, resolved);
              }
              return Response.json({ success: true });
            } catch (err) {
              console.error('[console] send-attachment failed:', err);
              return Response.json({ error: String(err) }, { status: 500 });
            }
          }

          if (url.pathname === '/api/flush' && req.method === 'POST') {
            const result = await handleCommand('flush');
            return Response.json(result);
          }
          if (url.pathname === '/api/esc' && req.method === 'POST') {
            const result = await handleCommand('esc');
            return Response.json(result);
          }
          if (url.pathname === '/api/restart' && req.method === 'POST') {
            const result = await handleCommand('restart');
            return Response.json(result);
          }
          // Message history and session APIs
          if (url.pathname === '/api/messages' && req.method === 'GET') {
            const limit = Number(url.searchParams.get('limit') ?? 100);
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            return Response.json(parseConversationLog(limit, sessionId));
          }
          if (url.pathname === '/api/sessions' && req.method === 'GET') {
            return Response.json(parseSessions());
          }
          // Task API routes
          if (url.pathname === '/api/tasks' && req.method === 'POST') {
            const body = await req.json() as CreateTaskInput;
            if (!body.role || !body.prompt || !body.description) {
              return Response.json({ error: 'role, description, prompt are required' }, { status: 400 });
            }
            const task = createTask(body);
            if (taskRunner) {
              taskRunner.runTask({
                taskId: task.id,
                role: task.role,
                prompt: task.prompt,
              });
            }
            return Response.json(task);
          }
          if (url.pathname === '/api/tasks' && req.method === 'GET') {
            const status = url.searchParams.get('status') ?? undefined;
            const role = url.searchParams.get('role') ?? undefined;
            const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
            return Response.json(listTasks({ status, role, limit }));
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/output') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/output'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'task not found' }, { status: 404 });
            if (!task.result_file) return Response.json({ error: 'no result file' }, { status: 404 });
            try {
              const content = readFileSync(task.result_file, 'utf-8');
              return Response.json({ content, path: task.result_file });
            } catch {
              return Response.json({ error: 'result file not readable' }, { status: 404 });
            }
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/cancel'.length);
            const ok = cancelTaskInDb(taskId);
            if (ok && taskRunner) taskRunner.cancelTask(taskId);
            return Response.json({ ok, taskId });
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/logs') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/logs'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'task not found' }, { status: 404 });
            const afterLine = Number(url.searchParams.get('after') ?? 0);
            const logData = parseTaskLog(taskId, afterLine);
            return Response.json(logData);
          }
          if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(task);
          }
          // Cron Jobs API routes
          if (url.pathname === '/api/cron-jobs' && req.method === 'GET') {
            return Response.json(listCronJobs());
          }
          if (url.pathname === '/api/cron-jobs' && req.method === 'POST') {
            const body = await req.json() as CreateCronJobInput;
            if (!body.name || !body.role || !body.prompt || !body.schedule || !body.description) {
              return Response.json({ error: 'name, role, description, prompt, schedule are required' }, { status: 400 });
            }
            return Response.json(createCronJob(body));
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && url.pathname.endsWith('/toggle') && req.method === 'POST') {
            const id = url.pathname.slice('/api/cron-jobs/'.length, -'/toggle'.length);
            const job = toggleCronJob(id);
            if (!job) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'GET') {
            const id = url.pathname.slice('/api/cron-jobs/'.length);
            const job = getCronJob(id);
            if (!job) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'PUT') {
            const id = url.pathname.slice('/api/cron-jobs/'.length);
            const body = await req.json() as Partial<CreateCronJobInput>;
            const job = updateCronJob(id, body);
            if (!job) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'DELETE') {
            const id = url.pathname.slice('/api/cron-jobs/'.length);
            const ok = deleteCronJob(id);
            return Response.json({ ok, id });
          }
          return new Response('Not found', { status: 404 });
        }
      }
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        // 立即推送一次当前状态
        ws.send(JSON.stringify(buildSnapshot()));
      },
      close(ws) {
        clients.delete(ws);
      },
      async message(ws, data) {
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === 'command' && msg.command) {
            const result = await handleCommand(msg.command);
            ws.send(JSON.stringify({
              type: 'command_result',
              command: msg.command,
              ...result,
            }));
          }
        } catch {
          // 忽略无效消息
        }
      },
    },
  });

  console.log(`[console] Web console started at http://localhost:${port}`);
}

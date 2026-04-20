import { randomUUID } from 'crypto';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, resolve, extname } from 'path';
import { homedir } from 'os';
import type { IncomingMessage, MessagingClient } from './messaging/messaging.js';
import type { DirectorPool } from './director-pool.js';
import { parseConversationLog, parseSessions, parseTaskLog } from './log-parser.js';

import type { SessionBridge } from './session-bridge.js';
import type { MessageQueue } from './queue.js';
import type { Config } from './config.js';
import type { TaskRunner } from './task/task-runner.js';
import { createTask, getTask, listTasks, cancelTask as cancelTaskInDb, getState, type CreateTaskInput, createCronJob, getCronJob, listCronJobs, updateCronJob, deleteCronJob, toggleCronJob, type CreateCronJobInput } from './task/task-store.js';

/** Minimal WebSocket interface — matches Bun.ServerWebSocket surface used here */
interface WsConnection {
  send(data: string): void;
}

// Shell 启动时间，用于计算 uptime
const startedAt = Date.now();

/** Attachment compositor buffer — implemented in index.ts */
export interface AttachmentBuffer {
  /** Buffer an attachment for a specific Director (by label) */
  push(source: string, filePath: string): void;
  /** Drain all buffered attachments for a specific Director */
  drain(source: string): string[];
  /** Whether the specified Director is currently processing a user message */
  isProcessing(source: string): boolean;
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
  director: SessionBridge,
  queue: MessageQueue,
  config: Config,
  taskRunner?: TaskRunner,
  messaging?: MessagingClient,
  metrics?: MetricsCollector,
  attachmentBuffer?: AttachmentBuffer,
  pool?: DirectorPool,
): MessagingClient {
  const port = config.console.port;
  const token = config.console.token;
  const publicDir = join(import.meta.dir, 'public');
  const htmlPath = join(publicDir, 'index.html');

  // Web chat 消息处理
  const chatHandlers: Array<(msg: IncomingMessage) => Promise<void> | void> = [];
  // messageId → { ws, createdAt } 连接，用于路由回复
  const messageWsMap = new Map<string, { ws: WsConnection; createdAt: number }>();

  // 每 60s 清理超过 5 分钟未回复的 entries，防止内存泄漏
  const MESSAGE_WS_TTL = 5 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of messageWsMap) {
      if (now - entry.createdAt > MESSAGE_WS_TTL) messageWsMap.delete(id);
    }
  }, 60_000);

  if (!config.console.enabled) {
    console.log('[console] Web console disabled by config');
    // 返回一个空的 MessagingClient stub
    return {
      start() {},
      onMessage(handler) { chatHandlers.push(handler); },
      async reply() {},
      async sendMessage() { return null; },
      async addReaction() {},
      async uploadAndReplyImage() {},
      async uploadAndReplyFile() {},
      async uploadAndSendImage() { return null; },
      async uploadAndSendFile() { return null; },
      getLastChatId() { return null; },
      getConnectionStatus() { return 'disconnected' as const; },
    };
  }

  /** 检查请求是否携带有效 token，未配置 token 时放行 */
  function checkAuth(req: Request): Response | null {
    if (!token) return null; // 未配置 token，放行
    // 支持 Bearer token (HTTP API) 和 query param ?token=xxx (WebSocket)
    const auth = req.headers.get('Authorization');
    if (auth === `Bearer ${token}`) return null;
    const url = new URL(req.url);
    if (url.searchParams.get('token') === token) return null;
    return new Response('Unauthorized', { status: 401 });
  }

  // 活跃的 WebSocket 连接集合
  const clients = new Set<WsConnection>();

  // 构建状态快照
  function buildSnapshot() {
    const ds = director.getStatus();
    const now = Date.now();

    // System status
    const messagingStatus = messaging?.getConnectionStatus() ?? 'disconnected';
    let systemStatus: 'healthy' | 'degraded' | 'error';
    if (messagingStatus === 'connected' && ds.alive) {
      systemStatus = 'healthy';
    } else if (messagingStatus === 'connected' || ds.alive) {
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
          messaging: messagingStatus,
          directorAlive: ds.alive,
          sessionId: ds.sessionId,
          sessionName: ds.sessionName,
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
        pool: pool ? pool.getPoolStatus().map((entry) => ({
          routingKey: entry.routingKey,
          groupName: entry.groupName,
          label: entry.label,
          lastActiveAt: entry.lastActiveAt,
          queueLength: entry.queueLength,
          activity: entry.directorStatus?.activityState ?? null,
          alive: entry.directorStatus?.alive ?? false,
          sessionId: entry.directorStatus?.sessionId ?? null,
          closed: entry.closed ?? false,
          closedAt: entry.closedAt ?? null,
          context: entry.directorStatus ? {
            tokens: entry.directorStatus.lastInputTokens,
            limit: entry.directorStatus.contextWindow > 0 ? entry.directorStatus.contextWindow : entry.directorStatus.flushContextLimit,
            lastFlushAt: entry.directorStatus.lastFlushAt,
          } : null,
        })) : [],
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
        case 'clear': {
          const success = await director.clearContext();
          return {
            ok: success,
            message: success ? 'Clear 完成，上下文已清空' : 'Clear 未能完成（正在进行中）',
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
        case 'session-restart': {
          await director.restartProcess();
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

  // Chunk / stream-abort broadcast for streaming UI
  function broadcastWs(payload: string) {
    for (const ws of clients) {
      try { ws.send(payload); } catch { clients.delete(ws); }
    }
  }

  director.on('chunk', (text: string) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chunk', director: director.label, text }));
  });
  director.on('stream-abort', () => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'stream-abort', director: director.label }));
  });

  if (pool) {
    pool.on('chunk', (label: string, text: string) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chunk', director: label, text }));
    });
    pool.on('stream-abort', (label: string) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'stream-abort', director: label }));
    });
    // Web session reply/alert routing
    pool.on('web-reply', (label: string, messageId: string, text: string) => {
      broadcastWs(JSON.stringify({ type: 'chat_reply', director: label, messageId, text }));
    });
    pool.on('web-alert', (label: string, message: string) => {
      broadcastWs(JSON.stringify({ type: 'chat_reply', director: label, messageId: null, text: '⚠️ ' + message }));
    });
  }

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
          // Serve static files from /css/ and /js/ subdirectories
          if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
            const filePath = resolve(publicDir, url.pathname.slice(1));
            // Prevent path traversal — resolved path must stay inside publicDir
            if (!filePath.startsWith(publicDir + '/')) {
              return new Response('Forbidden', { status: 403 });
            }
            if (existsSync(filePath) && statSync(filePath).isFile()) {
              const ext = extname(filePath).toLowerCase();
              const mimeTypes: Record<string, string> = {
                '.css': 'text/css; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
              };
              const content = readFileSync(filePath, 'utf-8');
              return new Response(content, {
                headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' },
              });
            }
          }

          // GET /api/state — read state.md and TODO.md for dashboard
          if (url.pathname === '/api/state' && req.method === 'GET') {
            const personaDir = config.director.persona_dir;
            let state = '';
            let todo = '';
            try { state = readFileSync(join(personaDir, 'daily', 'state.md'), 'utf-8'); } catch { /* ok */ }
            try { todo = readFileSync(join(personaDir, 'TODO.md'), 'utf-8'); } catch { /* ok */ }
            return Response.json({ state, todo });
          }

          // POST /api/send — send arbitrary text to Director (bypass messaging)
          if (url.pathname === '/api/send' && req.method === 'POST') {
            const body = await req.json() as { text: string; director?: string };
            if (!body.text) return Response.json({ ok: false, message: 'text is required' }, { status: 400 });
            try {
              // Route to pool Director if specified
              if (body.director && pool) {
                const poolStatus = pool.getPoolStatus().find((e) => e.label === body.director);
                if (poolStatus) {
                  const entry = pool.get(poolStatus.routingKey);
                  if (entry) {
                    await entry.bridge.send(body.text);
                    return Response.json({ ok: true, message: 'sent to pool director' });
                  }
                }
                return Response.json({ ok: false, message: `Pool director "${body.director}" not found` }, { status: 404 });
              }
              await director.send(body.text);
              return Response.json({ ok: true, message: 'sent' });
            } catch (err) {
              return Response.json({ ok: false, message: String(err) }, { status: 500 });
            }
          }

          // POST /api/send-attachment — send image/file to user via messaging
          if (url.pathname === '/api/send-attachment' && req.method === 'POST') {
            const body = await req.json() as { path: string; source_director?: string };
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

            if (!messaging) {
              return Response.json({ error: 'Messaging client not available' }, { status: 503 });
            }

            // Compositor: if this Director is processing a user message, buffer for later delivery
            const sourceDirector = body.source_director ?? 'main';
            if (attachmentBuffer?.isProcessing(sourceDirector)) {
              attachmentBuffer.push(sourceDirector, resolved);
              return Response.json({ queued: true });
            }

            // No pending response — send immediately as new message to lastChatId
            const ext = extname(resolved).toLowerCase();
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
            const isImage = imageExts.has(ext);

            try {
              // Resolve target chatId: pool Director → its group chat, main → lastChatId
              let targetChatId: string | null = null;
              if (sourceDirector && sourceDirector !== 'main' && pool) {
                targetChatId = pool.getChatIdByLabel(sourceDirector);
              }
              if (!targetChatId) {
                targetChatId = messaging.getLastChatId();
              }
              if (!targetChatId) return Response.json({ error: 'No active chat to send to' }, { status: 400 });
              if (isImage) {
                await messaging.uploadAndSendImage(targetChatId, resolved);
              } else {
                await messaging.uploadAndSendFile(targetChatId, resolved);
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
          if (url.pathname === '/api/clear' && req.method === 'POST') {
            const result = await handleCommand('clear');
            return Response.json(result);
          }
          if (url.pathname === '/api/esc' && req.method === 'POST') {
            const result = await handleCommand('esc');
            return Response.json(result);
          }
          if (url.pathname === '/api/session-restart' && req.method === 'POST') {
            const result = await handleCommand('session-restart');
            return Response.json(result);
          }
          // Message history and session APIs
          if (url.pathname === '/api/messages' && req.method === 'GET') {
            const limit = Number(url.searchParams.get('limit') ?? 100);
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            const directorLabel = url.searchParams.get('director') ?? undefined;
            let targetDirector = director;
            if (directorLabel && pool) {
              const entry = pool.getPoolStatus().find((e) => e.label === directorLabel);
              if (entry) {
                const poolEntry = pool.get(entry.routingKey);
                if (poolEntry) targetDirector = poolEntry.bridge;
              }
            }
            return Response.json(parseConversationLog(targetDirector.inputLogPath, targetDirector.outputLogPath, limit, sessionId));
          }
          if (url.pathname === '/api/sessions' && req.method === 'GET') {
            const directorLabel = url.searchParams.get('director') ?? undefined;
            let targetDirector = director;
            if (directorLabel && pool) {
              const entry = pool.getPoolStatus().find((e) => e.label === directorLabel);
              if (entry) {
                const poolEntry = pool.get(entry.routingKey);
                if (poolEntry) targetDirector = poolEntry.bridge;
              }
            }
            const sessions = parseSessions(targetDirector.outputLogPath);
            // Inject sessionName from persisted mapping + live Director status
            const nameMap = getState<Record<string, string>>('session:names') ?? {};
            for (const s of sessions) {
              if (!s.sessionName && nameMap[s.sessionId]) {
                s.sessionName = nameMap[s.sessionId];
              }
            }
            const ds = targetDirector.getStatus();
            if (ds.sessionId && ds.sessionName) {
              const live = sessions.find(s => s.sessionId === ds.sessionId);
              if (live) live.sessionName = ds.sessionName;
            }
            return Response.json(sessions);
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
                agent: task.agent ?? undefined,
                prompt: task.prompt,
                description: task.description,
                projectDir: (task.extra as Record<string, unknown>)?.project_dir as string | undefined,
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
          // Web session API routes
          if (url.pathname === '/api/web-sessions' && req.method === 'POST') {
            if (!pool) return Response.json({ error: 'Pool not available' }, { status: 503 });
            try {
              const id = randomUUID().slice(0, 8);
              const routingKey = `web-${id}`;
              const timeStr = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
              const entry = await pool.getOrCreate(routingKey, {
                groupName: `Web Chat ${timeStr}`,
                feishuChatId: 'web-console',
              });
              return Response.json({ ok: true, routingKey, label: entry.bridge.label });
            } catch (err) {
              return Response.json({ ok: false, error: String(err) }, { status: 500 });
            }
          }
          if (url.pathname.startsWith('/api/web-sessions/') && req.method === 'DELETE') {
            if (!pool) return Response.json({ error: 'Pool not available' }, { status: 503 });
            const routingKey = decodeURIComponent(url.pathname.slice('/api/web-sessions/'.length));
            try {
              await pool.shutdown(routingKey);
              return Response.json({ ok: true });
            } catch (err) {
              return Response.json({ ok: false, error: String(err) }, { status: 500 });
            }
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
        // Clean up pending chat entries for this connection
        for (const [id, entry] of messageWsMap) {
          if (entry.ws === ws) messageWsMap.delete(id);
        }
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
          } else if (msg.type === 'chat' && msg.text) {
            // Web chat 消息 — route to specific Director if specified
            const targetLabel: string | null = msg.director ?? null;
            if (targetLabel && pool) {
              // Route to pool Director via queue (ensures response correlation)
              const poolStatus = pool.getPoolStatus().find((e) => e.label === targetLabel);
              if (poolStatus) {
                const messageId = msg.messageId || `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                try {
                  await pool.send(poolStatus.routingKey, msg.text, messageId);
                } catch (err) {
                  console.error(`[console] Web chat send to pool "${targetLabel}" failed:`, err);
                }
                return;
              }
              console.warn(`[console] Pool Director "${targetLabel}" not found, falling back to main`);
            }
            // Fall back to main Director via MessagingClient handler
            const messageId = msg.messageId || `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            messageWsMap.set(messageId, { ws, createdAt: Date.now() });
            for (const handler of chatHandlers) {
              try {
                await handler({
                  text: msg.text,
                  messageId,
                  chatId: 'web-console',
                  chatType: 'p2p',
                });
              } catch (err) {
                console.error('[console] Web chat handler error:', err);
              }
            }
          }
        } catch {
          // 忽略无效消息
        }
      },
    },
  });

  console.log(`[console] Web console started at http://localhost:${port}`);

  // 返回 web 渠道的 MessagingClient
  const webClient: MessagingClient = {
    start() { /* already started above */ },
    onMessage(handler) { chatHandlers.push(handler); },
    async reply(messageId, text) {
      const entry = messageWsMap.get(messageId);
      if (entry) {
        try { entry.ws.send(JSON.stringify({ type: 'chat_reply', messageId, text })); } catch { /* client gone */ }
        messageWsMap.delete(messageId);
      }
    },
    async sendMessage(_chatId, text) {
      const payload = JSON.stringify({ type: 'chat_reply', messageId: null, text });
      for (const ws of clients) {
        try { ws.send(payload); } catch { /* client gone */ }
      }
      return null;
    },
    async addReaction() { /* no-op for web */ },
    async uploadAndReplyImage() { /* TODO: send image URL via WebSocket */ },
    async uploadAndReplyFile() { /* TODO: send file URL via WebSocket */ },
    async uploadAndSendImage() { return null; },
    async uploadAndSendFile() { return null; },
    getLastChatId() { return clients.size > 0 ? 'web-console' : null; },
    getConnectionStatus() { return clients.size > 0 ? 'connected' : 'disconnected'; },
  };
  return webClient;
}

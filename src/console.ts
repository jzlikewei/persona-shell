import { readFileSync } from 'fs';
import { join } from 'path';
import type { Director } from './director.js';
import type { MessageQueue } from './queue.js';
import type { Config } from './config.js';
import type { TaskRunner } from './task-runner.js';
import { createTask, getTask, listTasks, cancelTask as cancelTaskInDb, type CreateTaskInput } from './task-store.js';

// Shell 启动时间，用于计算 uptime
const startedAt = Date.now();

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
  feishu?: { getConnectionStatus: () => 'connected' | 'disconnected' },
  metrics?: MetricsCollector,
): void {
  if (!config.console.enabled) {
    console.log('[console] Web console disabled by config');
    return;
  }

  const port = config.console.port;
  const htmlPath = join(import.meta.dir, 'public', 'index.html');

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

    // Context
    const tokenPercent = ds.flushContextLimit > 0
      ? Math.round((ds.lastInputTokens / ds.flushContextLimit) * 100)
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
        },
        activity,
        context: {
          tokens: ds.lastInputTokens,
          limit: ds.flushContextLimit,
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
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/cancel'.length);
            const ok = cancelTaskInDb(taskId);
            if (ok && taskRunner) taskRunner.cancelTask(taskId);
            return Response.json({ ok, taskId });
          }
          if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(task);
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

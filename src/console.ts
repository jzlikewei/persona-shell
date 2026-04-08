import { readFileSync } from 'fs';
import { join } from 'path';
import type { Director } from './director.js';
import type { MessageQueue } from './queue.js';
import type { Config } from './config.js';

// Bridge 启动时间，用于计算 uptime
const startedAt = Date.now();

/**
 * 启动 Web 管理控制台（HTTP + WebSocket）
 * 用 Bun.serve() 提供单页 TUI 前端 + 实时状态推送 + 命令接收
 */
export function startConsole(
  director: Director,
  queue: MessageQueue,
  config: Config,
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
    return {
      type: 'status' as const,
      data: {
        director: director.getStatus(),
        queue: queue.getSnapshot(),
        bridge: {
          uptime: Date.now() - startedAt,
          memory: process.memoryUsage().rss,
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
        case '/api/flush': {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
          const result = await handleCommand('flush');
          return Response.json(result);
        }
        case '/api/esc': {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
          const result = await handleCommand('esc');
          return Response.json(result);
        }
        case '/api/restart': {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
          const result = await handleCommand('restart');
          return Response.json(result);
        }
        default:
          return new Response('Not found', { status: 404 });
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

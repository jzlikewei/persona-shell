/** Minimal MCP server (stdio transport) for task system — proxies to Shell HTTP API */

import { readdirSync } from 'fs';
import { join, basename } from 'path';

const SHELL_PORT = process.env.SHELL_PORT ?? '3000';
const SHELL_TOKEN = process.env.SHELL_TOKEN;
const DIRECTOR_LABEL = process.env.DIRECTOR_LABEL ?? 'main';
const PERSONA_DIR = process.env.PERSONA_DIR ?? '';
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '';
const BASE = `http://127.0.0.1:${SHELL_PORT}`;

/** Scan personas/ directory and return available role names */
function getAvailableRoles(): string[] {
  if (!PERSONA_DIR) return [];
  try {
    const dir = join(PERSONA_DIR, 'personas');
    return readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => basename(f, '.md'));
  } catch {
    return [];
  }
}

function buildRoleDescription(): string {
  const roles = getAvailableRoles();
  if (roles.length > 0) {
    return `角色名 (${roles.join(' / ')})`;
  }
  return '角色名 (explorer / executor / critic / philosopher / introspector / cron-builder)';
}

const TOOLS = [
  {
    name: 'create_task',
    description: '创建后台任务并 spawn 子角色进程',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role: { type: 'string', description: buildRoleDescription() },
        agent: { type: 'string', description: '可选 agent provider 名称；不传则使用该角色的默认 agent' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整 prompt' },
        project_dir: { type: 'string', description: '可选，子任务的工作目录（项目路径）；不传则默认在 persona 根目录下执行' },
        max_retry: { type: 'number', description: '最大重试次数 (默认 3)' },
      },
      required: ['role', 'description', 'prompt'],
    },
  },
  {
    name: 'get_task',
    description: '查询单条 task 详情',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: '列出最近的 tasks（可按 status/role 过滤）',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: '按状态过滤 (dispatched/running/completed/failed)' },
        role: { type: 'string', description: '按角色过滤' },
        limit: { type: 'number', description: '返回数量上限 (默认 20)' },
      },
    },
  },
  {
    name: 'cancel_task',
    description: '取消运行中的 task',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_cron_job',
    description: '创建定时 cron job（持久化到 SQLite，由 Scheduler 自动触发）。支持三种 action 类型：spawn_role（默认，spawn 子角色进程）、director_msg（给 Director 发系统消息）、shell_action（执行 Shell 内部动作）',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Job 名称' },
        role: { type: 'string', description: `${buildRoleDescription()}，action_type=director_msg 时可填 "system"` },
        agent: { type: 'string', description: '可选 agent provider 名称；不传则使用该角色的默认 agent' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整 prompt（action_type=spawn_role 时使用）' },
        schedule: { type: 'string', description: '调度表达式: "every 30m", "every 2h", "daily 09:00"' },
        action_type: { type: 'string', description: '动作类型: "spawn_role"(默认) | "director_msg" | "shell_action"', enum: ['spawn_role', 'director_msg', 'shell_action'] },
        message: { type: 'string', description: 'action_type=director_msg 时的消息内容，支持 {today} {yesterday} 模板变量' },
        action_name: { type: 'string', description: 'action_type=shell_action 时的动作名，如 "check_feishu"' },
      },
      required: ['name', 'role', 'description', 'prompt', 'schedule'],
    },
  },
  {
    name: 'list_cron_jobs',
    description: '列出所有 cron jobs',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'delete_cron_job',
    description: '删除 cron job',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Cron Job ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'toggle_cron_job',
    description: '切换 cron job 的启用/禁用状态',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Cron Job ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'send_attachment',
    description: '发送文件或图片给用户。Shell 自动处理上传和投递,Director 不需要关心投递渠道。支持图片(.png, .jpg, .jpeg, .gif, .webp)和任意文件格式。文件大小限制 10MB。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: '本地文件路径（支持 /tmp/ 和 ~/.persona/outbox/ 下的文件）',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_models',
    description: '列出当前可用的 Anthropic 模型',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

async function callShell(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (SHELL_TOKEN) headers['Authorization'] = `Bearer ${SHELL_TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shell API ${method} ${path} returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'create_task':
      return callShell('POST', '/api/tasks', {
        type: 'role',
        role: args.role,
        agent: args.agent,
        description: args.description,
        prompt: args.prompt,
        max_retry: args.max_retry,
        project_dir: args.project_dir,
        source_director: DIRECTOR_LABEL,
      });
    case 'get_task':
      return callShell('GET', `/api/tasks/${args.task_id}`);
    case 'list_tasks': {
      const params = new URLSearchParams();
      if (args.status) params.set('status', String(args.status));
      if (args.role) params.set('role', String(args.role));
      if (args.limit) params.set('limit', String(args.limit));
      const qs = params.toString();
      return callShell('GET', `/api/tasks${qs ? '?' + qs : ''}`);
    }
    case 'cancel_task':
      return callShell('POST', `/api/tasks/${args.task_id}/cancel`);
    case 'create_cron_job':
      return callShell('POST', '/api/cron-jobs', {
        name: args.name,
        role: args.role,
        agent: args.agent,
        description: args.description,
        prompt: args.prompt,
        schedule: args.schedule,
        action_type: args.action_type,
        message: args.message,
        action_name: args.action_name,
        source_director: DIRECTOR_LABEL,
      });
    case 'list_cron_jobs':
      return callShell('GET', '/api/cron-jobs');
    case 'delete_cron_job':
      return callShell('DELETE', `/api/cron-jobs/${args.id}`);
    case 'toggle_cron_job':
      return callShell('POST', `/api/cron-jobs/${args.id}/toggle`);
    case 'send_attachment':
      return callShell('POST', '/api/send-attachment', { path: args.path, source_director: DIRECTOR_LABEL });
    case 'list_models': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${ANTHROPIC_AUTH_TOKEN}`,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API returned ${res.status}: ${text}`);
      }
      return res.json();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC over stdio
const decoder = new TextDecoder();
let buffer = '';

async function processMessage(msg: { jsonrpc: string; id?: number; method: string; params?: unknown }) {
  const id = msg.id;

  switch (msg.method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'persona-tasks', version: '1.0.0' },
      });
    case 'notifications/initialized':
      return; // no response needed
    case 'tools/list':
      return respond(id, { tools: TOOLS });
    case 'tools/call': {
      const p = msg.params as { name: string; arguments?: Record<string, unknown> };
      try {
        const result = await handleToolCall(p.name, p.arguments ?? {});
        return respond(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return respond(id, {
          content: [{ type: 'text', text: `Error: ${err}` }],
          isError: true,
        });
      }
    }
    default:
      return respondError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function respond(id: number | undefined, result: unknown) {
  if (id === undefined) return;
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id: number | undefined, code: number, message: string) {
  if (id === undefined) return;
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function write(obj: unknown) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + '\n');
}

// Read stdin line by line
process.stdin.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      processMessage(msg).catch((err) => {
        process.stderr.write(`[task-mcp] Error: ${err}\n`);
      });
    } catch {
      process.stderr.write(`[task-mcp] Invalid JSON: ${line.slice(0, 100)}\n`);
    }
  }
});

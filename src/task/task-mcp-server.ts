/** Minimal MCP server (stdio transport) for task system — proxies to Shell HTTP API */

import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import {
  buildPersonaPromptBundle,
  listPersonaRoles,
  readPersonaMemory,
  writePersonaMemory,
  type PersonaMemoryScope,
} from '../persona-orchestration.js';

const SHELL_PORT = process.env.SHELL_PORT ?? '3000';
const DIRECTOR_LABEL = process.env.DIRECTOR_LABEL ?? 'main';
const PERSONA_WORKSPACE = process.env.PERSONA_WORKSPACE?.trim() || (DIRECTOR_LABEL === 'main' ? 'main' : DIRECTOR_LABEL);
const PERSONA_DIR = process.env.PERSONA_DIR ?? join(homedir(), '.persona');
const SHELL_TOKEN = process.env.SHELL_TOKEN ?? readShellTokenFromConfig(PERSONA_DIR);
const BASE = `http://127.0.0.1:${SHELL_PORT}`;

function readShellTokenFromConfig(personaDir: string): string | undefined {
  try {
    const text = readFileSync(join(personaDir, 'config.yaml'), 'utf-8');
    let inConsole = false;
    for (const line of text.split(/\r?\n/u)) {
      if (line && !line.startsWith(' ') && !line.startsWith('\t')) {
        inConsole = line.trim() === 'console:';
        continue;
      }
      if (!inConsole) continue;
      const match = line.match(/^\s+token:\s*["']?([^"'\s#]+)/u);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Best-effort fallback for MCP processes launched without SHELL_TOKEN.
  }
  return undefined;
}

function logStartupEnv(): void {
  console.error(`[mcp-server] env: DIRECTOR_LABEL=${DIRECTOR_LABEL} PERSONA_WORKSPACE=${PERSONA_WORKSPACE} PERSONA_SESSION_FILE=${process.env.PERSONA_SESSION_FILE?.trim() || '(none)'} PERSONA_SESSION_ID=${readPersonaSessionIdFromEnv() ?? '(none)'} SHELL_PORT=${SHELL_PORT}`);
}

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
    name: 'persona_list',
    description: '列出 persona-shell 可用人格角色及描述',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'persona_prompt',
    description: '读取指定人格的 Codex instruction 注入包，包含 baseInstructions 与 developerInstructions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role: { type: 'string', description: buildRoleDescription() },
        system_prompt_file: { type: 'string', description: '可选，额外 agent system prompt 文件，相对 persona_dir' },
      },
      required: ['role'],
    },
  },
  {
    name: 'persona_memory_read',
    description: '读取 persona-shell 记忆文件。scope=daily/memory/workspace/session',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['daily', 'memory', 'workspace', 'session'], description: '记忆范围' },
        key: { type: 'string', description: 'daily/memory 文件名、workspace 名或 session label' },
      },
      required: ['scope'],
    },
  },
  {
    name: 'persona_memory_write',
    description: '写入 persona-shell 记忆文件。用于更新 workspace context、session state 或长期记忆',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: ['daily', 'memory', 'workspace', 'session'], description: '记忆范围' },
        key: { type: 'string', description: 'daily/memory 文件名、workspace 名或 session label' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['scope', 'content'],
    },
  },
  {
    name: 'persona_delegate',
    description: '按 persona-shell 多 agent 方式派发子任务。等价于 create_task，但语义面向 Codex app',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role: { type: 'string', description: buildRoleDescription() },
        agent: { type: 'string', description: '可选 agent provider 名称' },
        model: { type: 'string', description: '可选 model 名称' },
        reasoning_effort: { type: 'string', description: '可选 Codex reasoning effort；按所选 model 的能力校验' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整任务 briefing' },
        project_dir: { type: 'string', description: '可选项目工作目录，用于让 Codex app workspace 对齐' },
        parent_codex_thread_id: { type: 'string', description: '可选，发起该子任务的 Codex thread id' },
        callback_codex_thread_id: { type: 'string', description: '可选，任务完成/失败后把通知作为模拟用户消息插入到该 Codex thread' },
        callback_cwd: { type: 'string', description: '可选，回插 Codex thread 时使用的 workspace cwd' },
        callback_on_done: { type: 'boolean', description: '可选，是否启用 Codex thread 回插；传 callback_codex_thread_id 时默认启用' },
        persona_session_id: { type: 'string', description: '可选，关联的 persona-shell session id' },
        channel: { type: 'string', description: '可选，来源渠道，如 codex/feishu/web' },
        external_id: { type: 'string', description: '可选，渠道侧会话 ID' },
        timeout_ms: { type: 'number', description: '可选超时时间，单位毫秒' },
      },
      required: ['role', 'description', 'prompt'],
    },
  },
  {
    name: 'persona_session_link',
    description: '绑定外部会话、persona session 与 Codex thread，便于飞书、Web、Codex app 共享会话资产',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: '来源渠道，如 feishu/web/codex' },
        external_id: { type: 'string', description: '渠道侧会话 ID，如 chat_id 或 web routing key' },
        persona_session_id: { type: 'string', description: 'persona-shell session id' },
        session_id: { type: 'string', description: 'pShell sessionId，用于绑定当前 workspace/session' },
        workspace: { type: 'string', description: 'workspace name' },
        codex_thread_id: { type: 'string', description: 'Codex thread id' },
        director_label: { type: 'string', description: '@deprecated legacy runtime label；请使用 session_id/workspace' },
        role: { type: 'string', description: '当前 persona role' },
      },
      required: ['channel', 'external_id'],
    },
  },
  {
    name: 'create_task',
    description: '创建后台任务并 spawn 子角色进程',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role: { type: 'string', description: buildRoleDescription() },
        agent: { type: 'string', description: '可选 agent provider 名称；不传则使用该角色的默认 agent' },
        model: { type: 'string', description: '可选 model 名称；不传则使用角色或 provider 的默认 model' },
        reasoning_effort: { type: 'string', description: '可选 Codex reasoning effort；按所选 model 的能力校验' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整 prompt' },
        project_dir: { type: 'string', description: '可选，子任务的工作目录（项目路径）；不传则默认在 persona 根目录下执行' },
        max_retry: { type: 'number', description: '最大重试次数 (默认 3)' },
        timeout_ms: { type: 'number', description: '可选，任务超时时间（毫秒）；不传则使用 config 默认值。运行中可通过 DB 修改并自动同步' },
        callback_codex_thread_id: { type: 'string', description: '可选，任务完成/失败后把通知作为模拟用户消息插入到该 Codex thread' },
        callback_cwd: { type: 'string', description: '可选，回插 Codex thread 时使用的 workspace cwd' },
        callback_on_done: { type: 'boolean', description: '可选，是否启用 Codex thread 回插；传 callback_codex_thread_id 时默认启用' },
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
    description: '创建定时 cron job（持久化到 SQLite，由 Scheduler 自动触发）。支持三种 action 类型：spawn_role（默认，spawn 子角色进程）、director_msg（给 Director 发系统消息）、shell_action（执行 Shell 内部动作或任意 bash 命令）',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Job 名称' },
        role: { type: 'string', description: `${buildRoleDescription()}，action_type=director_msg 时可填 "system"` },
        agent: { type: 'string', description: '可选 agent provider 名称；不传则使用该角色的默认 agent' },
        model: { type: 'string', description: '可选 model 名称；不传则使用角色或 provider 的默认 model' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整 prompt（action_type=spawn_role 时使用）' },
        schedule: { type: 'string', description: '调度表达式: "every 30m", "every 2h", "daily 09:00"' },
        action_type: { type: 'string', description: '动作类型: "spawn_role"(默认) | "director_msg" | "shell_action"', enum: ['spawn_role', 'director_msg', 'shell_action'] },
        message: { type: 'string', description: 'action_type=director_msg 时的消息内容，支持 {today} {yesterday} 模板变量' },
        action_name: { type: 'string', description: 'action_type=shell_action 时的动作名。内置动作: "check_feishu" / "check_flush" / "flush"；以 "!" 开头表示执行任意 bash 命令，如 "!cd /path && ./run.sh"' },
        timeout_ms: { type: 'number', description: 'action_type=shell_action 时的超时时间，单位毫秒；不传默认 5 分钟' },
        max_retry: { type: 'number', description: 'action_type=shell_action 失败后的最大重试次数，默认 3' },
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
    name: 'update_cron_job',
    description: '更新 cron job，保留原 id 与未指定字段',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Cron Job ID' },
        name: { type: 'string', description: '可选：Job 名称' },
        role: { type: 'string', description: `可选：${buildRoleDescription()}，action_type=director_msg 时可填 "system"` },
        agent: { type: 'string', description: '可选：agent provider 名称' },
        description: { type: 'string', description: '可选：简短描述' },
        prompt: { type: 'string', description: '可选：完整 prompt（action_type=spawn_role 时使用）' },
        schedule: { type: 'string', description: '可选：调度表达式: "every 30m", "every 2h", "daily 09:00"' },
        enabled: { type: 'boolean', description: '可选：启用/禁用' },
        action_type: { type: 'string', description: '可选：动作类型: "spawn_role" | "director_msg" | "shell_action"', enum: ['spawn_role', 'director_msg', 'shell_action'] },
        message: { type: 'string', description: '可选：action_type=director_msg 时的消息内容' },
        action_name: { type: 'string', description: '可选：action_type=shell_action 时的动作名' },
        timeout_ms: { type: 'number', description: '可选：shell_action 超时时间，单位毫秒' },
        max_retry: { type: 'number', description: '可选：shell_action 失败后的最大重试次数' },
        workspace: { type: 'string', description: '可选：迁移/修正所属 workspace' },
        source_session_id: { type: 'string', description: '可选：修正创建/回调 source session id' },
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

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function buildCodexCallback(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const threadId = typeof args.callback_codex_thread_id === 'string'
    ? args.callback_codex_thread_id.trim()
    : '';
  if (!threadId) return undefined;
  if (args.callback_on_done === false) return undefined;
  return compactRecord({
    type: 'codex_thread',
    thread_id: threadId,
    cwd: typeof args.callback_cwd === 'string' ? args.callback_cwd.trim() : undefined,
  });
}

function stringFromPath(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function inferCodexThreadId(args: Record<string, unknown>): string | undefined {
  const direct = typeof args.callback_codex_thread_id === 'string' && args.callback_codex_thread_id.trim()
    ? args.callback_codex_thread_id.trim()
    : undefined;
  if (direct) return direct;

  const meta = args._meta;
  return (
    stringFromPath(meta, ['x-codex-turn-metadata', 'thread_id']) ??
    stringFromPath(meta, ['x-codex-turn-metadata', 'session_id']) ??
    stringFromPath(meta, ['threadId']) ??
    stringFromPath(meta, ['thread_id']) ??
    stringFromPath(meta, ['session_id']) ??
    process.env.CODEX_THREAD_ID?.trim() ??
    process.env.CODEX_SESSION_ID?.trim()
  ) || undefined;
}

function inferCodexMetadataSessionId(args: Record<string, unknown>): string | undefined {
  const meta = args._meta;
  return (
    stringFromPath(meta, ['x-codex-turn-metadata', 'thread_id']) ??
    stringFromPath(meta, ['x-codex-turn-metadata', 'session_id']) ??
    stringFromPath(meta, ['threadId']) ??
    stringFromPath(meta, ['thread_id']) ??
    stringFromPath(meta, ['session_id'])
  );
}

function readPersonaSessionIdFromEnv(): string | undefined {
  return process.env.PERSONA_SESSION_ID?.trim() || undefined;
}

function readPersonaSessionIdFromFile(): string | undefined {
  const path = process.env.PERSONA_SESSION_FILE?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function inferSourceSessionId(args: Record<string, unknown>): string | undefined {
  // Prefer per-turn Codex metadata, then Shell's session file SSOT. The env
  // fallback is kept only for legacy callers because MCP servers can start
  // before Claude/Codex has produced a session id.
  return inferCodexMetadataSessionId(args)
    ?? readPersonaSessionIdFromFile()
    ?? readPersonaSessionIdFromEnv()
    ?? process.env.CODEX_THREAD_ID?.trim()
    ?? process.env.CODEX_SESSION_ID?.trim()
    ?? undefined;
}

function inferCodexCwd(args: Record<string, unknown>): string | undefined {
  if (typeof args.callback_cwd === 'string' && args.callback_cwd.trim()) {
    return args.callback_cwd.trim();
  }
  const workspaces = stringFromPath(args._meta, ['x-codex-turn-metadata', 'workspaces']);
  if (workspaces) return workspaces;
  const metadata = args._meta && typeof args._meta === 'object'
    ? (args._meta as Record<string, unknown>)['x-codex-turn-metadata']
    : undefined;
  const workspaceMap = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).workspaces
    : undefined;
  if (workspaceMap && typeof workspaceMap === 'object' && !Array.isArray(workspaceMap)) {
    const first = Object.keys(workspaceMap)[0];
    if (first) return first;
  }
  return process.env.CODEX_CWD?.trim() || process.env.PWD?.trim() || undefined;
}

function withCodexCallbackDefaults(args: Record<string, unknown>): Record<string, unknown> {
  const threadId = inferCodexThreadId(args);
  if (!threadId || args.callback_on_done === false) return args;
  return {
    ...args,
    callback_codex_thread_id: threadId,
    callback_cwd: inferCodexCwd(args),
    parent_codex_thread_id: typeof args.parent_codex_thread_id === 'string' && args.parent_codex_thread_id.trim()
      ? args.parent_codex_thread_id
      : threadId,
  };
}

export function buildPersonaDelegateTaskRequest(args: Record<string, unknown>): Record<string, unknown> {
  const enrichedArgs = withCodexCallbackDefaults(args);
  return {
    type: 'role',
    role: enrichedArgs.role,
    agent: enrichedArgs.agent,
    model: enrichedArgs.model,
    reasoning_effort: enrichedArgs.reasoning_effort,
    description: enrichedArgs.description,
    prompt: enrichedArgs.prompt,
    project_dir: enrichedArgs.project_dir,
    timeout_ms: enrichedArgs.timeout_ms,
    source_session_id: inferSourceSessionId(enrichedArgs),
    workspace: PERSONA_WORKSPACE,
    extra: compactRecord({
      persona_role: enrichedArgs.role,
      parent_codex_thread_id: enrichedArgs.parent_codex_thread_id,
      persona_session_id: enrichedArgs.persona_session_id,
      channel: enrichedArgs.channel,
      external_id: enrichedArgs.external_id,
      codex_callback: buildCodexCallback(enrichedArgs),
    }),
  };
}

export function buildCreateTaskRequest(args: Record<string, unknown>): Record<string, unknown> {
  const enrichedArgs = withCodexCallbackDefaults(args);
  return {
    type: 'role',
    role: enrichedArgs.role,
    agent: enrichedArgs.agent,
    model: enrichedArgs.model,
    reasoning_effort: enrichedArgs.reasoning_effort,
    description: enrichedArgs.description,
    prompt: enrichedArgs.prompt,
    max_retry: enrichedArgs.max_retry,
    project_dir: enrichedArgs.project_dir,
    timeout_ms: enrichedArgs.timeout_ms,
    source_session_id: inferSourceSessionId(enrichedArgs),
    workspace: PERSONA_WORKSPACE,
    extra: compactRecord({
      codex_callback: buildCodexCallback(enrichedArgs),
    }),
  };
}

export function buildCreateCronJobRequest(args: Record<string, unknown>): Record<string, unknown> {
  const enrichedArgs = withCodexCallbackDefaults(args);
  return {
    name: enrichedArgs.name,
    role: enrichedArgs.role,
    agent: enrichedArgs.agent,
    description: enrichedArgs.description,
    prompt: enrichedArgs.prompt,
    schedule: enrichedArgs.schedule,
    action_type: enrichedArgs.action_type,
    message: enrichedArgs.message,
    action_name: enrichedArgs.action_name,
    timeout_ms: enrichedArgs.timeout_ms,
    max_retry: enrichedArgs.max_retry,
    workspace: PERSONA_WORKSPACE,
    source_session_id: inferSourceSessionId(enrichedArgs),
  };
}

export function buildUpdateCronJobRequest(args: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    'name',
    'role',
    'agent',
    'description',
    'prompt',
    'schedule',
    'enabled',
    'action_type',
    'message',
    'action_name',
    'timeout_ms',
    'max_retry',
    'workspace',
    'source_session_id',
  ];
  const request: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      request[key] = args[key];
    }
  }
  return request;
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const enrichedArgs = withCodexCallbackDefaults(args);
  switch (name) {
    case 'persona_list':
      return { roles: listPersonaRoles(PERSONA_DIR) };
    case 'persona_prompt':
      return buildPersonaPromptBundle(PERSONA_DIR, String(enrichedArgs.role), {
        systemPromptFile: typeof enrichedArgs.system_prompt_file === 'string' ? enrichedArgs.system_prompt_file : null,
      });
    case 'persona_memory_read':
      return readPersonaMemory(PERSONA_DIR, String(enrichedArgs.scope) as PersonaMemoryScope, typeof enrichedArgs.key === 'string' ? enrichedArgs.key : undefined);
    case 'persona_memory_write':
      return writePersonaMemory(
        PERSONA_DIR,
        String(enrichedArgs.scope) as PersonaMemoryScope,
        typeof enrichedArgs.key === 'string' ? enrichedArgs.key : undefined,
        String(enrichedArgs.content ?? ''),
      );
    case 'persona_delegate':
      return callShell('POST', '/api/tasks', buildPersonaDelegateTaskRequest(enrichedArgs));
    case 'persona_session_link':
      return callShell('POST', '/api/persona/session-links', {
        channel: enrichedArgs.channel,
        external_id: enrichedArgs.external_id,
        persona_session_id: enrichedArgs.persona_session_id,
        codex_thread_id: enrichedArgs.codex_thread_id,
        session_id: enrichedArgs.session_id ?? inferSourceSessionId(enrichedArgs),
        workspace: enrichedArgs.workspace ?? PERSONA_WORKSPACE,
        director_label: enrichedArgs.director_label,
        role: enrichedArgs.role,
      });
    case 'create_task':
      return callShell('POST', '/api/tasks', buildCreateTaskRequest(enrichedArgs));
    case 'get_task':
      return callShell('GET', `/api/tasks/${enrichedArgs.task_id}`);
    case 'list_tasks': {
      const params = new URLSearchParams();
      if (enrichedArgs.status) params.set('status', String(enrichedArgs.status));
      if (enrichedArgs.role) params.set('role', String(enrichedArgs.role));
      if (enrichedArgs.limit) params.set('limit', String(enrichedArgs.limit));
      const qs = params.toString();
      return callShell('GET', `/api/tasks${qs ? '?' + qs : ''}`);
    }
    case 'cancel_task':
      return callShell('POST', `/api/tasks/${enrichedArgs.task_id}/cancel`);
    case 'create_cron_job':
      return callShell('POST', '/api/cron-jobs', buildCreateCronJobRequest(enrichedArgs));
    case 'list_cron_jobs':
      return callShell('GET', '/api/cron-jobs');
    case 'delete_cron_job':
      return callShell('DELETE', `/api/cron-jobs/${enrichedArgs.id}`);
    case 'update_cron_job':
      return callShell('PUT', `/api/cron-jobs/${enrichedArgs.id}`, buildUpdateCronJobRequest(enrichedArgs));
    case 'toggle_cron_job':
      return callShell('POST', `/api/cron-jobs/${enrichedArgs.id}/toggle`);
    case 'send_attachment':
      return callShell('POST', '/api/send-attachment', {
        path: enrichedArgs.path,
        source_session_id: inferSourceSessionId(enrichedArgs),
        workspace: PERSONA_WORKSPACE,
        // Legacy compatibility for old Shells only; the API routes by session/workspace first.
        source_director: DIRECTOR_LABEL,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function normalizeCliToolName(name: string): string {
  return name.replace(/-/g, '_');
}

function printCliUsage(): never {
  const usage = [
    'Usage:',
    '  task-mcp-server.ts cli <tool> [json-args]',
    '  task-mcp-server.ts cli <tool> -',
    '',
    'Tools:',
    '  persona_list, persona_prompt, persona_memory_read, persona_memory_write',
    '  persona_delegate, persona_session_link',
    '  create_task, get_task, list_tasks, cancel_task',
    '  create_cron_job, list_cron_jobs, update_cron_job, delete_cron_job, toggle_cron_job',
    '  send_attachment',
    '',
    'Examples:',
    `  bun run src/task/task-mcp-server.ts cli list_tasks '{"limit":5}'`,
    `  printf '{"role":"explorer","description":"demo","prompt":"read code"}' | bun run src/task/task-mcp-server.ts cli create_task -`,
  ].join('\n');
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

async function runCli(argv: string[]): Promise<void> {
  const tool = argv[0];
  if (!tool || tool === '-h' || tool === '--help') printCliUsage();

  const rawArgs = argv[1] ?? '{}';
  let parsedArgs: unknown;
  try {
    const json = rawArgs === '-' ? readFileSync(0, 'utf-8') : rawArgs;
    parsedArgs = json.trim() ? JSON.parse(json) : {};
  } catch (err) {
    process.stderr.write(`Invalid JSON args: ${err}\n`);
    process.exit(2);
  }

  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    process.stderr.write('JSON args must be an object\n');
    process.exit(2);
  }

  try {
    const result = await handleToolCall(normalizeCliToolName(tool), parsedArgs as Record<string, unknown>);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`Error: ${err}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  if (process.argv[2] === 'cli') {
    runCli(process.argv.slice(3));
  } else {
    runMcpServer();
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
      const p = msg.params as { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
      try {
        const result = await handleToolCall(p.name, {
          ...(p.arguments ?? {}),
          ...(p._meta ? { _meta: p._meta } : {}),
        });
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

function runMcpServer(): void {
  logStartupEnv();
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
}

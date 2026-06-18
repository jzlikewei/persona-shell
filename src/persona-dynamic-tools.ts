import {
  resolveCronWorkspaceAlias,
  type CreateCronJobInput,
  type CreateTaskInput,
  type CronActionType,
  type CronJob,
  type Task,
} from './task/task-store.js';
import type {
  DirectorDynamicToolCall,
  DirectorDynamicToolResult,
} from './director-session-adapter/index.js';

export type DynamicToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const PERSONA_DYNAMIC_TOOLS: DynamicToolSchema[] = [
  {
    name: 'create_task',
    description: '创建 persona-shell 后台任务。只提供业务参数；Shell 会自动绑定当前 session/workspace 用于完成回调。',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色名，如 explorer / executor / introspector' },
        agent: { type: 'string', description: '可选 agent provider 名称' },
        model: { type: 'string', description: '可选 model 名称' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整任务 briefing' },
        project_dir: { type: 'string', description: '可选项目工作目录' },
        timeout_ms: { type: 'number', description: '可选超时时间，单位毫秒' },
        max_retry: { type: 'number', description: '最大重试次数' },
      },
      required: ['role', 'description', 'prompt'],
    },
  },
  {
    name: 'list_tasks',
    description: '列出 persona-shell 最近的后台任务，可按状态/角色过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '按状态过滤：dispatched/running/completed/failed' },
        role: { type: 'string', description: '按角色过滤' },
        limit: { type: 'number', description: '返回数量上限' },
      },
    },
  },
  {
    name: 'get_task',
    description: '查询单条 persona-shell 后台任务详情。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_cron_job',
    description: '创建 persona-shell 定时任务。Shell 会绑定当前 workspace；Codex dynamic 模式不经 HTTP token。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job 名称' },
        role: { type: 'string', description: '角色名；action_type=director_msg 时可填 system' },
        agent: { type: 'string', description: '可选 agent provider 名称' },
        description: { type: 'string', description: '简短描述' },
        prompt: { type: 'string', description: '完整 prompt（action_type=spawn_role 时使用）' },
        schedule: { type: 'string', description: '调度表达式: "every 30m", "every 2h", "daily 09:00"' },
        action_type: { type: 'string', description: '动作类型: "spawn_role"(默认) | "director_msg" | "shell_action"', enum: ['spawn_role', 'director_msg', 'shell_action'] },
        message: { type: 'string', description: 'action_type=director_msg 时的消息内容，支持 {today} {yesterday} 模板变量' },
        action_name: { type: 'string', description: 'action_type=shell_action 时的动作名。内置动作: "check_feishu" / "check_flush" / "flush"；以 "!" 开头表示执行任意 bash 命令' },
        timeout_ms: { type: 'number', description: 'action_type=shell_action 时的超时时间，单位毫秒' },
        max_retry: { type: 'number', description: 'action_type=shell_action 失败后的最大重试次数' },
      },
      required: ['name', 'role', 'description', 'prompt', 'schedule'],
    },
  },
  {
    name: 'list_cron_jobs',
    description: '列出当前 workspace 的 persona-shell cron jobs。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delete_cron_job',
    description: '删除 persona-shell cron job。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron Job ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_cron_job',
    description: '更新当前 workspace 可见的 persona-shell cron job，保留原 id 与未指定字段。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron Job ID' },
        name: { type: 'string', description: '可选：Job 名称' },
        role: { type: 'string', description: '可选：角色名；action_type=director_msg 时可填 system' },
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
      },
      required: ['id'],
    },
  },
  {
    name: 'toggle_cron_job',
    description: '切换 persona-shell cron job 的启用/禁用状态。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Cron Job ID' },
      },
      required: ['id'],
    },
  },
];

export type PersonaDynamicToolCall = DirectorDynamicToolCall & {
  sourceSessionId: string | null;
  workspace: string;
};

export interface PersonaDynamicToolDeps {
  createTask(input: CreateTaskInput): Task;
  listTasks(filter?: { status?: string; role?: string; workspace?: string; limit?: number }): Task[];
  getTask(taskId: string): Task | null;
  runTask(input: {
    taskId: string;
    role: string;
    agent?: string;
    model?: string;
    prompt: string;
    description: string;
    projectDir?: string;
    timeoutMs?: number;
  }): void;
  createCronJob(input: CreateCronJobInput): CronJob;
  listCronJobs(): CronJob[];
  updateCronJob(id: string, update: Partial<Omit<CronJob, 'id' | 'created_at' | 'source_director'>>): CronJob | null;
  deleteCronJob(id: string): boolean;
  toggleCronJob(id: string): CronJob | null;
}

function recordToString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordToNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordToBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function recordToCronActionType(value: unknown): CronActionType | undefined {
  return value === 'spawn_role' || value === 'director_msg' || value === 'shell_action' ? value : undefined;
}

function dynamicToolArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cronJobBelongsToWorkspace(job: CronJob, workspace: string): boolean {
  return (resolveCronWorkspaceAlias(job.workspace) ?? 'main') === workspace;
}

function canAccessCronJob(deps: PersonaDynamicToolDeps, id: string, workspace: string): boolean {
  return deps.listCronJobs().some((job) => job.id === id && cronJobBelongsToWorkspace(job, workspace));
}

export async function handlePersonaDynamicToolCall(
  call: PersonaDynamicToolCall,
  deps: PersonaDynamicToolDeps,
): Promise<DirectorDynamicToolResult> {
  const args = dynamicToolArgs(call.arguments);
  try {
    if (call.tool === 'create_task') {
      const role = recordToString(args.role);
      const description = recordToString(args.description);
      const prompt = recordToString(args.prompt);
      if (!role || !description || !prompt) {
        return { success: false, text: 'role, description, prompt are required' };
      }
      const model = recordToString(args.model);
      const projectDir = recordToString(args.project_dir);
      const task = deps.createTask({
        type: 'role',
        role,
        agent: recordToString(args.agent),
        model,
        description,
        prompt,
        project_dir: projectDir,
        max_retry: recordToNumber(args.max_retry),
        timeout_ms: recordToNumber(args.timeout_ms),
        workspace: call.workspace,
        source_session_id: call.sourceSessionId ?? undefined,
        extra: {
          ...(model ? { model } : {}),
          ...(projectDir ? { project_dir: projectDir } : {}),
          parent_workspace: call.workspace,
          parent_session_id: call.sourceSessionId,
        },
      });
      deps.runTask({
        taskId: task.id,
        role: task.role,
        agent: task.agent ?? undefined,
        model,
        prompt: task.prompt,
        description: task.description,
        projectDir,
        timeoutMs: task.timeout_ms ?? undefined,
      });
      return { success: true, text: JSON.stringify(task, null, 2) };
    }
    if (call.tool === 'list_tasks') {
      const tasks = deps.listTasks({
        status: recordToString(args.status),
        role: recordToString(args.role),
        workspace: call.workspace,
        limit: recordToNumber(args.limit),
      });
      return { success: true, text: JSON.stringify(tasks, null, 2) };
    }
    if (call.tool === 'get_task') {
      const taskId = recordToString(args.task_id);
      if (!taskId) return { success: false, text: 'task_id is required' };
      const task = deps.getTask(taskId);
      if (!task) return { success: false, text: `Task not found: ${taskId}` };
      return { success: true, text: JSON.stringify(task, null, 2) };
    }
    if (call.tool === 'create_cron_job') {
      const name = recordToString(args.name);
      const role = recordToString(args.role);
      const description = recordToString(args.description);
      const prompt = recordToString(args.prompt);
      const schedule = recordToString(args.schedule);
      if (!name || !role || !description || !prompt || !schedule) {
        return { success: false, text: 'name, role, description, prompt, schedule are required' };
      }
      const job = deps.createCronJob({
        name,
        role,
        agent: recordToString(args.agent),
        description,
        prompt,
        schedule,
        action_type: recordToCronActionType(args.action_type),
        message: recordToString(args.message),
        action_name: recordToString(args.action_name),
        timeout_ms: recordToNumber(args.timeout_ms),
        max_retry: recordToNumber(args.max_retry),
        workspace: call.workspace,
        source_session_id: call.sourceSessionId ?? undefined,
      });
      return { success: true, text: JSON.stringify(job, null, 2) };
    }
    if (call.tool === 'list_cron_jobs') {
      const jobs = deps.listCronJobs().filter((job) => cronJobBelongsToWorkspace(job, call.workspace));
      return { success: true, text: JSON.stringify(jobs, null, 2) };
    }
    if (call.tool === 'delete_cron_job') {
      const id = recordToString(args.id);
      if (!id) return { success: false, text: 'id is required' };
      if (!canAccessCronJob(deps, id, call.workspace)) return { success: false, text: `Cron job not found: ${id}` };
      const ok = deps.deleteCronJob(id);
      if (!ok) return { success: false, text: `Cron job not found: ${id}` };
      return { success: true, text: JSON.stringify({ ok, id }, null, 2) };
    }
    if (call.tool === 'update_cron_job') {
      const id = recordToString(args.id);
      if (!id) return { success: false, text: 'id is required' };
      if (!canAccessCronJob(deps, id, call.workspace)) return { success: false, text: `Cron job not found: ${id}` };

      const update: Partial<Omit<CronJob, 'id' | 'created_at' | 'source_director'>> = {};
      const stringFields = ['name', 'role', 'agent', 'description', 'prompt', 'schedule', 'message', 'action_name', 'workspace', 'source_session_id'] as const;
      for (const field of stringFields) {
        if (field in args) {
          const value = recordToString(args[field]);
          if (!value && !['agent', 'message', 'action_name', 'workspace', 'source_session_id'].includes(field)) {
            return { success: false, text: `${field} must be a non-empty string` };
          }
          (update as Record<string, unknown>)[field] = value ?? null;
        }
      }
      if ('enabled' in args) {
        const enabled = recordToBoolean(args.enabled);
        if (enabled === undefined) return { success: false, text: 'enabled must be boolean' };
        update.enabled = enabled;
      }
      if ('action_type' in args) {
        const actionType = recordToCronActionType(args.action_type);
        if (!actionType) return { success: false, text: 'action_type must be spawn_role, director_msg or shell_action' };
        update.action_type = actionType;
      }
      if ('timeout_ms' in args) {
        const value = recordToNumber(args.timeout_ms);
        if (value === undefined) return { success: false, text: 'timeout_ms must be number' };
        update.timeout_ms = value;
      }
      if ('max_retry' in args) {
        const value = recordToNumber(args.max_retry);
        if (value === undefined) return { success: false, text: 'max_retry must be number' };
        update.max_retry = value;
      }

      const job = deps.updateCronJob(id, update);
      if (!job) return { success: false, text: `Cron job not found: ${id}` };
      return { success: true, text: JSON.stringify(job, null, 2) };
    }
    if (call.tool === 'toggle_cron_job') {
      const id = recordToString(args.id);
      if (!id) return { success: false, text: 'id is required' };
      if (!canAccessCronJob(deps, id, call.workspace)) return { success: false, text: `Cron job not found: ${id}` };
      const job = deps.toggleCronJob(id);
      if (!job) return { success: false, text: `Cron job not found: ${id}` };
      return { success: true, text: JSON.stringify(job, null, 2) };
    }
    return { success: false, text: `Unsupported dynamic tool: ${call.tool}` };
  } catch (err) {
    return { success: false, text: err instanceof Error ? err.message : String(err) };
  }
}

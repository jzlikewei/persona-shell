import { existsSync, readFileSync } from 'fs';
import { load } from 'js-yaml';
import { dirname, resolve } from 'path';
import { homedir } from 'os';

export type AgentProviderType = 'claude' | 'codex';
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'max';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApproval = 'untrusted' | 'on-request' | 'never';

export interface AgentProviderConfig {
  type: AgentProviderType;
  command: string;
  bare?: boolean;
  dangerously_skip_permissions?: boolean;
  effort?: ClaudeEffort;
  sandbox?: CodexSandbox;
  approval?: CodexApproval;
  search?: boolean;
  model?: string;
  /** Per-agent system prompt file, relative to persona_dir (e.g. "prompts/gemini.md") */
  system_prompt_file?: string;
}

export interface RoleOverride {
  agent?: string;
  model?: string;
}

export interface AgentsConfig {
  defaults: Record<string, string>;
  providers: Record<string, AgentProviderConfig>;
  roles?: Record<string, RoleOverride>;
}

export interface Config {
  agents: AgentsConfig;
  feishu: {
    app_id: string;
    app_secret: string;
    master_id?: string;
  };
  director: {
    persona_dir: string;
    pipe_dir: string;
    pid_file: string;
    time_sync_interval_ms: number;
    flush_context_limit: number;
    flush_interval_ms: number;
    quote_max_length: number;
  };
  console: {
    enabled: boolean;
    port: number;
    token?: string;
  };
  task: {
    default_timeout_ms: number;
  };
  scheduler: {
    enabled: boolean;
    intervalMinutes: number;
  };
  pool: {
    max_directors: number;
    idle_timeout_minutes: number;
    small_group_threshold: number;
    parallel_chat_ids: string[];  // 配置为"并行模式"的群 chat_id，始终走 DirectorPool
    mention_only_chat_ids: string[];  // 这些群必须 @bot 才响应，无论群人数
  };
  logging: {
    level: string;
    queue_log: string;
  };
}

function expandHome(p: string): string {
  return p.startsWith('~/') || p === '~' ? homedir() + p.slice(1) : p;
}

export function getDefaultAgentName(agents: AgentsConfig, role: string): string {
  return agents.roles?.[role]?.agent ?? agents.defaults[role] ?? agents.defaults.default ?? 'claude';
}

export function resolveAgentProvider(agents: AgentsConfig, role: string, agentName?: string): { name: string } & AgentProviderConfig {
  const name = agentName ?? getDefaultAgentName(agents, role);
  const provider = agents.providers[name];
  if (!provider) {
    throw new Error(`Unknown agent provider "${name}" for role "${role}"`);
  }
  const roleModel = agents.roles?.[role]?.model;
  if (roleModel && !agentName) {
    return { name, ...provider, model: roleModel };
  }
  return { name, ...provider };
}

export function defaultConfigPath(): string {
  return resolve(homedir(), '.persona', 'config.yaml');
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? defaultConfigPath();
  const raw = readFileSync(configPath, 'utf-8');
  const yaml = load(raw) as Record<string, any>;
  const secretPath = resolve(dirname(configPath), 'im_secret.yaml');
  const secretYaml = existsSync(secretPath)
    ? (load(readFileSync(secretPath, 'utf-8')) as Record<string, any>)
    : {};

  const feishu = {
    ...(yaml.feishu ?? {}),
    ...(secretYaml.feishu ?? {}),
  };

  if (!feishu.app_id || !feishu.app_secret) {
    throw new Error('feishu.app_id is required in config.yaml, feishu.app_secret is required in im_secret.yaml (or config.yaml for compatibility)');
  }

  const dir = yaml.director ?? {};
  const con = yaml.console ?? {};
  const rawProviders = yaml.agents?.providers as Record<string, {
    type?: unknown;
    command?: unknown;
    bare?: unknown;
    dangerously_skip_permissions?: unknown;
    effort?: unknown;
    sandbox?: unknown;
    approval?: unknown;
    search?: unknown;
    model?: unknown;
    system_prompt_file?: unknown;
  }> | undefined;
  const providerEntries = Object.entries(rawProviders ?? {});
  const providers: Record<string, AgentProviderConfig> = {};

  for (const [name, provider] of providerEntries) {
    const type = provider?.type;
    const command = provider?.command;
    if ((type === 'claude' || type === 'codex') && typeof command === 'string' && command.trim()) {
      providers[name] = {
        type,
        command: command.trim(),
        ...(typeof provider?.bare === 'boolean' ? { bare: provider.bare } : {}),
        ...(typeof provider?.dangerously_skip_permissions === 'boolean'
          ? { dangerously_skip_permissions: provider.dangerously_skip_permissions }
          : {}),
        ...(provider?.effort === 'low' || provider?.effort === 'medium' || provider?.effort === 'high' || provider?.effort === 'max'
          ? { effort: provider.effort }
          : {}),
        ...(provider?.sandbox === 'read-only' || provider?.sandbox === 'workspace-write' || provider?.sandbox === 'danger-full-access'
          ? { sandbox: provider.sandbox }
          : {}),
        ...(provider?.approval === 'untrusted' || provider?.approval === 'on-request' || provider?.approval === 'never'
          ? { approval: provider.approval }
          : {}),
        ...(typeof provider?.search === 'boolean' ? { search: provider.search } : {}),
        ...(typeof provider?.model === 'string' && provider.model.trim() ? { model: provider.model.trim() } : {}),
        ...(typeof provider?.system_prompt_file === 'string' && provider.system_prompt_file.trim()
          ? { system_prompt_file: provider.system_prompt_file.trim() }
          : {}),
      };
    }
  }

  if (!providers.claude) {
    providers.claude = {
      type: 'claude',
      command: 'claude',
      bare: true,
      dangerously_skip_permissions: true,
      effort: 'max',
    };
  }

  if (!providers.codex) {
    providers.codex = {
      type: 'codex',
      command: 'codex',
      sandbox: 'danger-full-access',
      approval: 'never',
      search: false,
    };
  }

  const defaults: Record<string, string> = yaml.agents?.defaults && typeof yaml.agents.defaults === 'object'
    ? Object.fromEntries(
      Object.entries(yaml.agents.defaults as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([role, value]) => [role, (value as string).trim()]),
    )
    : {};

  if (!defaults.director) {
    defaults.director = 'claude';
  }
  if (!defaults.default) {
    defaults.default = 'claude';
  }

  const rawRoles = yaml.agents?.roles as Record<string, { agent?: unknown; model?: unknown }> | undefined;
  const roles: Record<string, RoleOverride> = {};
  if (rawRoles && typeof rawRoles === 'object') {
    for (const [role, override] of Object.entries(rawRoles)) {
      if (!override || typeof override !== 'object') continue;
      const entry: RoleOverride = {};
      if (typeof override.agent === 'string' && override.agent.trim()) entry.agent = override.agent.trim();
      if (typeof override.model === 'string' && override.model.trim()) entry.model = override.model.trim();
      if (entry.agent || entry.model) roles[role] = entry;
    }
  }

  return {
    agents: {
      defaults,
      providers,
      roles,
    },
    feishu,
    director: {
      persona_dir: expandHome(dir.persona_dir ?? '~/.persona'),
      pipe_dir: dir.pipe_dir ?? '/tmp/persona',
      pid_file: dir.pid_file ?? '/tmp/persona/director.pid',
      time_sync_interval_ms: dir.time_sync_interval_hours
        ? Number(dir.time_sync_interval_hours) * 3600_000
        : 2 * 3600_000,
      flush_context_limit: Number(dir.flush_context_limit ?? 700_000),
      flush_interval_ms: dir.flush_interval_days
        ? Number(dir.flush_interval_days) * 86_400_000
        : 7 * 86_400_000,
      quote_max_length: Number(dir.quote_max_length ?? 32),
    },
    console: {
      enabled: con.enabled !== false,
      port: Number(con.port ?? 3000),
      token: con.token ?? undefined,
    },
    task: {
      default_timeout_ms: Number(yaml.task?.default_timeout_minutes ?? 10) * 60_000,
    },
    scheduler: {
      enabled: yaml.scheduler?.enabled !== false,
      intervalMinutes: Number(yaml.scheduler?.interval_minutes ?? 30),
    },
    pool: {
      max_directors: Number(yaml.pool?.max_directors ?? 8),
      idle_timeout_minutes: Number(yaml.pool?.idle_timeout_minutes ?? 30),
      small_group_threshold: Number(yaml.pool?.small_group_threshold ?? 5),
      parallel_chat_ids: Array.isArray(yaml.pool?.parallel_chat_ids) ? yaml.pool.parallel_chat_ids : [],
      mention_only_chat_ids: Array.isArray(yaml.pool?.mention_only_chat_ids) ? yaml.pool.mention_only_chat_ids : [],
    },
    logging: {
      level: yaml.logging?.level ?? 'info',
      queue_log: yaml.logging?.queue_log ?? 'logs/queue.log',
    },
  };
}

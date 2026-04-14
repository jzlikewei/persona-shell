import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { resolve } from 'path';
import { homedir } from 'os';

export type AgentProviderType = 'claude' | 'codex';

export interface AgentProviderConfig {
  type: AgentProviderType;
  command: string;
  args?: string[];
  foreground_args?: string[];
  background_args?: string[];
}

export interface AgentsConfig {
  defaults: Record<string, string>;
  providers: Record<string, AgentProviderConfig>;
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
  return agents.defaults[role] ?? agents.defaults.default ?? 'claude';
}

export function resolveAgentProvider(agents: AgentsConfig, role: string, agentName?: string): { name: string } & AgentProviderConfig {
  const name = agentName ?? getDefaultAgentName(agents, role);
  const provider = agents.providers[name];
  if (!provider) {
    throw new Error(`Unknown agent provider "${name}" for role "${role}"`);
  }
  return { name, ...provider };
}

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolve(homedir(), '.persona', 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const yaml = load(raw) as Record<string, any>;

  if (!yaml.feishu?.app_id || !yaml.feishu?.app_secret) {
    throw new Error('feishu.app_id and feishu.app_secret are required in config.yaml');
  }

  const dir = yaml.director ?? {};
  const con = yaml.console ?? {};
  const rawProviders = yaml.agents?.providers as Record<string, {
    type?: unknown;
    command?: unknown;
    args?: unknown;
    foreground_args?: unknown;
    background_args?: unknown;
  }> | undefined;
  const providerEntries = Object.entries(rawProviders ?? {});
  const providers: Record<string, AgentProviderConfig> = {};

  const normalizeArgs = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const args = value.filter((arg): arg is string => typeof arg === 'string' && arg.length > 0);
    return args.length > 0 ? args : undefined;
  };

  for (const [name, provider] of providerEntries) {
    const type = provider?.type;
    const command = provider?.command;
    if ((type === 'claude' || type === 'codex') && typeof command === 'string' && command.trim()) {
      const args = normalizeArgs(provider?.args);
      const foregroundArgs = normalizeArgs(provider?.foreground_args);
      const backgroundArgs = normalizeArgs(provider?.background_args);
      providers[name] = {
        type,
        command: command.trim(),
        ...(args ? { args } : {}),
        ...(foregroundArgs ? { foreground_args: foregroundArgs } : {}),
        ...(backgroundArgs ? { background_args: backgroundArgs } : {}),
      };
    }
  }

  if (!providers.claude) {
    providers.claude = {
      type: 'claude',
      command: 'claude',
      foreground_args: [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--input-format', 'stream-json',
        '--bare',
        '--effort', 'max',
        '--include-partial-messages',
      ],
      background_args: [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--bare',
      ],
    };
  }

  if (!providers.codex) {
    providers.codex = {
      type: 'codex',
      command: 'codex',
      background_args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
      ],
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

  return {
    agents: {
      defaults,
      providers,
    },
    feishu: yaml.feishu,
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
    },
    logging: {
      level: yaml.logging?.level ?? 'info',
      queue_log: yaml.logging?.queue_log ?? 'logs/queue.log',
    },
  };
}

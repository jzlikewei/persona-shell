/**
 * persona-process.ts — 公共进程 spawn 模块
 *
 * 提取 Director 和子角色共用的 Claude CLI 参数构建与进程启动逻辑，
 * 消除 director.ts 和 task-runner.ts 之间的重复代码。
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { getLogDir } from './logger.js';
import type { AgentProviderConfig } from './config.js';

export interface AgentRuntimeConfig extends AgentProviderConfig {
  name: string;
}

export interface PersonaSpawnOptions {
  /** 角色名: "director" | "explorer" | "critic" | ... */
  role: string;
  /** persona 根目录 (~/.persona) */
  personaDir: string;
  /** agent provider 配置 */
  agent: AgentRuntimeConfig;
  /** foreground: FIFO 双向管道 (Director); background: 一次性 prompt (子角色) */
  mode: 'foreground' | 'background';
  // --- transport / runtime 配置 ---
  /** MCP 配置文件路径。Claude Director 走 --mcp-config；Codex turn-based 走 -c mcp_servers.* overrides */
  mcpConfigPath?: string;
  /** 恢复已有 session */
  sessionId?: string;
  /** session 显示名称（通过 --name 传入，如 "director-main-20260412"） */
  sessionName?: string;
  /** FIFO 输入管道路径 */
  pipeIn?: string;
  /** FIFO 输出管道路径 */
  pipeOut?: string;
  // --- background 专用 ---
  /** 一次性 prompt (通过 -p 传入) */
  prompt?: string;
  /** 恢复已有 codex session/thread */
  resumeSessionId?: string;
  /** 子任务工作目录（项目路径），覆盖默认的 personaDir 作为 cwd */
  projectDir?: string;
  // --- 公共 ---
  /** stderr 日志文件完整路径 */
  stderrPath?: string;
  /** 额外 CLI 参数 */
  extraArgs?: string[];
  /** 额外环境变量（与 process.env 合并后传给子进程） */
  env?: Record<string, string>;
}

export interface SpawnResult {
  child: ChildProcess;
  /** 最终传给 claude CLI 的参数列表（用于调试/记录） */
  args: string[];
}

function buildClaudeInjectionArgs(personaDir: string): string[] {
  const personasDir = join(personaDir, 'personas');

  const args = ['--add-dir', personaDir, '--plugin-dir', personasDir];

  // soul.md + meta.md 系统提示文件
  const soulFile = join(personaDir, 'soul.md');
  const metaFile = join(personaDir, 'meta.md');
  if (existsSync(soulFile)) args.push('--append-system-prompt-file', soulFile);
  if (existsSync(metaFile)) args.push('--append-system-prompt-file', metaFile);

  return args;
}

/**
 * 构建角色专属参数：--append-system-prompt-file personas/{role}.md
 * 统一用 CLI flag 注入角色人格，不再手工读文件 strip frontmatter
 */
function buildClaudeRoleArgs(role: string, personaDir: string): string[] {
  const personaFile = join(personaDir, 'personas', `${role}.md`);
  if (existsSync(personaFile)) {
    return ['--append-system-prompt-file', personaFile];
  }
  return [];
}

/**
 * 构建 Claude agent 级别的 system prompt 参数。
 * 如果 agent config 指定了 system_prompt_file，注入为 --append-system-prompt-file。
 * 路径相对于 personaDir 解析。
 */
function buildClaudeAgentPromptArgs(agent: PersonaSpawnOptions['agent'], personaDir: string): string[] {
  if (!agent.system_prompt_file) return [];
  const filePath = join(personaDir, agent.system_prompt_file);
  if (existsSync(filePath)) {
    return ['--append-system-prompt-file', filePath];
  }
  console.warn(`[persona-process] Agent system_prompt_file not found: ${filePath}`);
  return [];
}

function readAgentPromptFile(agent: PersonaSpawnOptions['agent'], personaDir: string): string {
  if (!agent.system_prompt_file) return '';
  const filePath = join(personaDir, agent.system_prompt_file);
  if (existsSync(filePath)) {
    return readFileSync(filePath, 'utf-8').trim();
  }
  console.warn(`[persona-process] Agent system_prompt_file not found: ${filePath}`);
  return '';
}

/**
 * Shell 安全引用：含特殊字符的参数用单引号包裹
 */
function shellQuote(arg: string): string {
  if (!/[^a-zA-Z0-9_./:=@-]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * 将参数数组转为 shell 命令字符串
 */
function argsToShellCmd(executable: string, args: string[]): string {
  return `${executable} ${args.map(shellQuote).join(' ')}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(value: Record<string, string>): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`;
}

function tomlBareKey(value: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function buildCodexMcpOverrideArgs(mcpConfigPath?: string, mcpEnvOverrides?: Record<string, string>): string[] {
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
      mcpServers?: Record<string, {
        command?: unknown;
        args?: unknown;
        env?: unknown;
      }>;
    };
    const servers = raw.mcpServers;
    if (!servers || typeof servers !== 'object') return [];

    const args: string[] = [];
    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server !== 'object' || typeof server.command !== 'string' || !server.command.trim()) {
        continue;
      }
      const pathKey = tomlBareKey(name);
      if (!pathKey) {
        console.warn(`[persona-process] Skipping MCP server with unsupported Codex key: ${name}`);
        continue;
      }

      const base = `mcp_servers.${pathKey}`;
      args.push('-c', `${base}.command=${tomlString(server.command.trim())}`);

      const serverArgs = Array.isArray(server.args)
        ? server.args.filter((value): value is string => typeof value === 'string')
        : [];
      if (serverArgs.length > 0) {
        args.push('-c', `${base}.args=[${serverArgs.map(tomlString).join(', ')}]`);
      }

      const envEntries = server.env && typeof server.env === 'object'
        ? Object.entries(server.env as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        : [];
      const mergedEnv = Object.fromEntries(envEntries);
      if (mcpEnvOverrides) {
        Object.assign(mergedEnv, mcpEnvOverrides);
      }
      if (Object.keys(mergedEnv).length > 0) {
        args.push('-c', `${base}.env=${tomlInlineTable(mergedEnv)}`);
      }
    }
    return args;
  } catch {
    return [];
  }
}

function buildCodexTaskCliPrompt(personaDir: string, mcpConfigPath?: string, directorLabel?: string): string {
  if (!mcpConfigPath || !existsSync(mcpConfigPath)) return '';

  try {
    const raw = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
      mcpServers?: Record<string, {
        command?: unknown;
        args?: unknown;
        env?: unknown;
      }>;
    };
    const server = raw.mcpServers?.['persona-tasks'];
    if (!server || typeof server !== 'object') return '';
    const command = typeof server.command === 'string' && server.command.trim()
      ? server.command.trim()
      : 'bun';
    const serverArgs = Array.isArray(server.args)
      ? server.args.filter((value): value is string => typeof value === 'string')
      : [];
    if (serverArgs.length === 0) return '';

    const envEntries = server.env && typeof server.env === 'object'
      ? Object.entries(server.env as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      : [];
    const mergedEnv = Object.fromEntries(envEntries);
    if (directorLabel) mergedEnv.DIRECTOR_LABEL = directorLabel;
    if (!mergedEnv.PERSONA_DIR) mergedEnv.PERSONA_DIR = personaDir;

    const envPrefix = Object.entries(mergedEnv)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(' ');
    const baseCommand = [envPrefix, command, ...serverArgs, 'cli']
      .filter(Boolean)
      .map((part, index) => index === 0 && part === envPrefix ? part : shellQuote(part))
      .join(' ');

    return [
      'Codex task system access:',
      `- Use \`${baseCommand} list_tasks '{"limit":20}'\` to inspect tasks.`,
      `- Use \`${baseCommand} create_task '{"role":"explorer","description":"short description","prompt":"full prompt"}'\` to create background tasks.`,
      `- Use \`${baseCommand} get_task '{"task_id":"T-..."}'\` to inspect one task.`,
      `- Use \`${baseCommand} send_attachment '{"path":"/tmp/file-or-outbox-file"}'\` to send a file.`,
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * 为 Kimi 构建注入 DIRECTOR_LABEL 的临时 MCP 配置文件。
 * Kimi CLI 通过 --mcp-config-file 读取 JSON，没有 Codex 的 -c override 机制，
 * 因此需要在启动前把 DIRECTOR_LABEL 写进配置文件的 env 中。
 * 返回临时配置文件路径（放在系统 tmp 目录）。
 */
function buildKimiMcpConfigWithEnv(mcpConfigPath: string, directorLabel: string): string {
  try {
    const raw = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as {
      mcpServers?: Record<string, {
        command?: unknown;
        args?: unknown;
        env?: Record<string, string>;
      }>;
    };
    const servers = raw.mcpServers;
    if (!servers || typeof servers !== 'object') return mcpConfigPath;

    for (const server of Object.values(servers)) {
      if (server && typeof server === 'object') {
        server.env = { ...(server.env ?? {}), DIRECTOR_LABEL: directorLabel };
      }
    }

    const tmpDir = join('/tmp', 'persona-mcp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${directorLabel}.mcp.json`);
    writeFileSync(tmpPath, JSON.stringify(raw, null, 2));
    return tmpPath;
  } catch {
    return mcpConfigPath;
  }
}

/**
 * 统一 spawn agent 进程。
 * - foreground 模式：当前仅支持 Claude，通过 sh -c 做 FIFO 管道重定向 (Director)
 * - background 模式：stdout pipe 用于读取 JSON/stream-json 输出 (子角色)
 */
export function spawnPersona(options: PersonaSpawnOptions): SpawnResult {
  const args: string[] = [];

  if (options.agent.type === 'codex') {
    if (options.agent.model) {
      args.push('--model', options.agent.model);
    }
    if (options.agent.sandbox === 'danger-full-access' && options.agent.approval === 'never') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      if (options.agent.sandbox) {
        args.push('--sandbox', options.agent.sandbox);
      }
      if (options.agent.approval) {
        args.push('--ask-for-approval', options.agent.approval);
      }
    }
    if (options.agent.search) {
      args.push('--search');
    }
    const mcpEnvOverrides: Record<string, string> = {};
    if (options.env?.DIRECTOR_LABEL) {
      mcpEnvOverrides.DIRECTOR_LABEL = options.env.DIRECTOR_LABEL;
    }
    if (options.agent.mcp_mode === 'mcp') {
      args.push(...buildCodexMcpOverrideArgs(options.mcpConfigPath, mcpEnvOverrides));
    }
    const codexCd = (options.mode === 'background' && options.projectDir && existsSync(options.projectDir))
      ? options.projectDir
      : options.personaDir;
    args.push('--cd', codexCd);
  }

  if (options.agent.type === 'kimi') {
    // Kimi print mode implies --yolo; no need to pass it explicitly.
    const workDir = (options.mode === 'background' && options.projectDir && existsSync(options.projectDir))
      ? options.projectDir
      : options.personaDir;
    args.push('--print', '--work-dir', workDir);
    if (options.agent.model) {
      args.push('--model', options.agent.model);
    }
    if (options.agent.agent_file) {
      const agentFile = join(options.personaDir, options.agent.agent_file);
      if (existsSync(agentFile)) {
        args.push('--agent-file', agentFile);
      }
    }
    if (options.agent.skills_dir) {
      const skillsDir = join(options.personaDir, options.agent.skills_dir);
      if (existsSync(skillsDir)) {
        args.push('--skills-dir', skillsDir);
      }
    }
    if (options.mcpConfigPath && existsSync(options.mcpConfigPath)) {
      // Kimi 没有 Codex 的 -c TOML override 机制，需要动态注入 DIRECTOR_LABEL
      const mcpPath = (options.env?.DIRECTOR_LABEL)
        ? buildKimiMcpConfigWithEnv(options.mcpConfigPath, options.env.DIRECTOR_LABEL)
        : options.mcpConfigPath;
      args.push('--mcp-config-file', mcpPath);
    }
    if (options.mode === 'foreground') {
      args.push('--input-format', 'stream-json', '--output-format', 'stream-json');
      if (options.sessionId) args.push('--session', options.sessionId);
    }
    if (options.mode === 'background') {
      args.push('--output-format', 'stream-json');
      if (options.resumeSessionId) args.push('--session', options.resumeSessionId);
      if (options.prompt) {
        const fullPrompt = buildInjectedPrompt(options.role, options.personaDir, options.prompt);
        args.push('--prompt', fullPrompt);
      }
    }
  }

  // foreground (Director) 专用参数（仅 Claude）
  if (options.mode === 'foreground' && options.agent.type === 'claude') {
    args.push(
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--input-format', 'stream-json',
      '--include-partial-messages',
    );
    if (options.agent.dangerously_skip_permissions !== false) {
      args.push('--dangerously-skip-permissions');
    }
    if (options.agent.bare !== false) {
      args.push('--bare');
    }
    if (options.agent.effort) {
      args.push('--effort', options.agent.effort);
    }
    if (options.agent.model) {
      args.push('--model', options.agent.model);
    }
    args.push(...buildClaudeInjectionArgs(options.personaDir));
    args.push(...buildClaudeAgentPromptArgs(options.agent, options.personaDir));
    args.push(...buildClaudeRoleArgs(options.role, options.personaDir));
    if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.sessionName) args.push('--name', options.sessionName);
  }

  if (options.mode === 'foreground' && options.agent.type !== 'claude' && options.agent.type !== 'kimi') {
    throw new Error(`Foreground mode is not supported for agent provider "${options.agent.name}"`);
  }

  // background (子角色) 专用参数
  if (options.mode === 'background') {
    if (options.agent.type === 'claude') {
      args.push('--print', '--output-format', 'stream-json', '--verbose');
      if (options.agent.dangerously_skip_permissions !== false) {
        args.push('--dangerously-skip-permissions');
      }
      if (options.agent.bare !== false) {
        args.push('--bare');
      }
      if (options.agent.model) {
        args.push('--model', options.agent.model);
      }
      args.push(...buildClaudeInjectionArgs(options.personaDir));
      args.push(...buildClaudeAgentPromptArgs(options.agent, options.personaDir));
      args.push(...buildClaudeRoleArgs(options.role, options.personaDir));
      if (options.prompt) args.push('-p', options.prompt);
    } else if (options.agent.type === 'codex') {
      args.push('exec');
      if (options.resumeSessionId) {
        args.push('resume', options.resumeSessionId);
      }
      args.push('--json', '--skip-git-repo-check');
      const prompt = options.resumeSessionId
        ? (options.prompt ?? '')
        : buildInjectedPrompt(
            options.role,
            options.personaDir,
            options.prompt ?? '',
            [
              readAgentPromptFile(options.agent, options.personaDir),
              options.agent.mcp_mode !== 'mcp' && options.agent.mcp_mode !== 'off'
                ? buildCodexTaskCliPrompt(options.personaDir, options.mcpConfigPath, options.env?.DIRECTOR_LABEL)
                : '',
            ].filter(Boolean).join('\n\n'),
          );
      if (prompt) args.push(prompt);
    }
  }

  // 额外参数
  if (options.extraArgs) args.push(...options.extraArgs);

  // stderr 重定向到日志文件
  const defaultLogDir = getLogDir();
  const stderrPath = options.stderrPath ?? join(defaultLogDir, `${options.role}-stderr.log`);
  const stderrDir = dirname(stderrPath);
  if (!existsSync(stderrDir)) mkdirSync(stderrDir, { recursive: true });
  const stderrFd = openSync(stderrPath, 'a');

  // Merge extra env vars (e.g. DIRECTOR_LABEL) into process env for child.
  // Always build an explicit env object so we can strip inherited vars
  // that restrict Claude Code's tool set (e.g. CLAUDE_CODE_SIMPLE).
  const childEnv = (() => {
    const base = { ...process.env };
    // Remove inherited env vars that restrict Claude Code's tool set
    delete base.CLAUDE_CODE_SIMPLE;
    if (options.env) Object.assign(base, options.env);
    return base;
  })();

  // Resolve working directory: projectDir overrides personaDir for background tasks
  const cwd = (options.mode === 'background' && options.projectDir && existsSync(options.projectDir))
    ? options.projectDir
    : options.personaDir;

  let child: ChildProcess;

  if (options.mode === 'foreground' && options.agent.type === 'kimi') {
    // Kimi print mode: direct stdin/stdout pipe (no FIFO)
    child = spawn(options.agent.command, args, {
      detached: true,
      stdio: ['pipe', 'pipe', stderrFd],
      cwd,
      env: childEnv,
    });
  } else if (options.mode === 'foreground' && options.pipeIn && options.pipeOut) {
    // FIFO 管道：通过 sh -c 重定向 stdin/stdout (Claude)
    const cmd = argsToShellCmd(options.agent.command, args);
    child = spawn('sh', ['-c', `${cmd} < "${options.pipeIn}" > "${options.pipeOut}"`], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      cwd,
      env: childEnv,
    });
  } else {
    // background：stdout pipe 用于读取 JSON/stream-json 输出
    child = spawn(options.agent.command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', stderrFd],
      cwd,
      env: childEnv,
    });
  }

  // 关闭父进程的 stderr fd 副本（子进程已继承自己的副本）
  closeSync(stderrFd);
  child.unref();

  return { child, args };
}

function buildInjectedPrompt(role: string, personaDir: string, taskPrompt: string, agentPrompt = ''): string {
  const sections: string[] = [];

  if (agentPrompt.trim()) {
    sections.push(`## Injected agent\n\n${agentPrompt.trim()}`);
  }

  const promptFiles = [
    { label: 'soul', path: join(personaDir, 'soul.md') },
    { label: 'meta', path: join(personaDir, 'meta.md') },
    { label: `persona:${role}`, path: join(personaDir, 'personas', `${role}.md`) },
  ];

  for (const file of promptFiles) {
    if (!existsSync(file.path)) continue;
    try {
      const content = readFileSync(file.path, 'utf-8').trim();
      if (content) {
        sections.push(`## Injected ${file.label}\n\n${content}`);
      }
    } catch {
      // best-effort
    }
  }

  if (taskPrompt.trim()) {
    sections.push(`## Task\n\n${taskPrompt.trim()}`);
  }

  return sections.join('\n\n');
}

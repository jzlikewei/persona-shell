/**
 * persona-process.ts — 公共进程 spawn 模块
 *
 * 提取 Director 和子角色共用的 Claude CLI 参数构建与进程启动逻辑，
 * 消除 director.ts 和 task-runner.ts 之间的重复代码。
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync, mkdirSync, openSync, closeSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
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
  // --- foreground 专用 ---
  /** MCP 配置文件路径 */
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
  const skillsDir = join(personaDir, 'skills');

  const args = ['--add-dir', personaDir, '--plugin-dir', personasDir];

  // soul.md + meta.md 系统提示文件
  const soulFile = join(personaDir, 'soul.md');
  const metaFile = join(personaDir, 'meta.md');
  if (existsSync(soulFile)) args.push('--append-system-prompt-file', soulFile);
  if (existsSync(metaFile)) args.push('--append-system-prompt-file', metaFile);

  // skills/ 子目录作为 plugin-dir
  try {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        args.push('--plugin-dir', join(skillsDir, d.name));
      }
    }
  } catch { /* skills 目录可能不存在 */ }

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

/**
 * 统一 spawn agent 进程。
 * - foreground 模式：当前仅支持 Claude，通过 sh -c 做 FIFO 管道重定向 (Director)
 * - background 模式：stdout pipe 用于读取 JSON/stream-json 输出 (子角色)
 */
export function spawnPersona(options: PersonaSpawnOptions): SpawnResult {
  const args = [...(options.agent.args ?? [])];

  // foreground (Director) 专用参数
  if (options.mode === 'foreground') {
    if (options.agent.type !== 'claude') {
      throw new Error(`Foreground mode is not supported for agent provider "${options.agent.name}"`);
    }
    args.push(...(options.agent.foreground_args ?? []));
    args.push(...buildClaudeInjectionArgs(options.personaDir));
    args.push(...buildClaudeRoleArgs(options.role, options.personaDir));
    if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.sessionName) args.push('--name', options.sessionName);
  }

  // background (子角色) 专用参数
  if (options.mode === 'background') {
    if (options.agent.type === 'claude') {
      args.push(...(options.agent.background_args ?? []));
      args.push(...buildClaudeInjectionArgs(options.personaDir));
      args.push(...buildClaudeRoleArgs(options.role, options.personaDir));
      if (options.prompt) args.push('-p', options.prompt);
    } else if (options.agent.type === 'codex') {
      args.push(...(options.agent.background_args ?? []));
      args.push('--cd', options.personaDir);
      const prompt = buildCodexPrompt(options.role, options.personaDir, options.prompt ?? '');
      if (prompt) args.push(prompt);
    }
  }

  // 额外参数
  if (options.extraArgs) args.push(...options.extraArgs);

  // stderr 重定向到日志文件
  const defaultLogDir = join(import.meta.dirname, '..', 'logs');
  const stderrPath = options.stderrPath ?? join(defaultLogDir, `${options.role}-stderr.log`);
  const stderrDir = dirname(stderrPath);
  if (!existsSync(stderrDir)) mkdirSync(stderrDir, { recursive: true });
  const stderrFd = openSync(stderrPath, 'a');

  // Merge extra env vars (e.g. DIRECTOR_LABEL) into process env for child
  const childEnv = options.env
    ? { ...process.env, ...options.env }
    : undefined;  // undefined = inherit parent env as-is

  let child: ChildProcess;

  if (options.mode === 'foreground' && options.pipeIn && options.pipeOut) {
    // FIFO 管道：通过 sh -c 重定向 stdin/stdout
    const cmd = argsToShellCmd(options.agent.command, args);
    child = spawn('sh', ['-c', `${cmd} < "${options.pipeIn}" > "${options.pipeOut}"`], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      cwd: options.personaDir,
      env: childEnv,
    });
  } else {
    // background：stdout pipe 用于读取 JSON/stream-json 输出
    child = spawn(options.agent.command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', stderrFd],
      cwd: options.personaDir,
      env: childEnv,
    });
  }

  // 关闭父进程的 stderr fd 副本（子进程已继承自己的副本）
  closeSync(stderrFd);
  child.unref();

  return { child, args };
}

function buildCodexPrompt(role: string, personaDir: string, taskPrompt: string): string {
  const sections: string[] = [];
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

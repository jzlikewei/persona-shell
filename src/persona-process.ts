/**
 * persona-process.ts — 公共进程 spawn 模块
 *
 * 提取 Director 和子角色共用的 Claude CLI 参数构建与进程启动逻辑，
 * 消除 director.ts 和 task-runner.ts 之间的重复代码。
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync, mkdirSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';

export interface PersonaSpawnOptions {
  /** 角色名: "director" | "explorer" | "critic" | ... */
  role: string;
  /** persona 根目录 (~/.persona) */
  personaDir: string;
  /** claude CLI 路径 */
  claudePath: string;
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

/**
 * 构建公共 CLI 参数：--add-dir, --plugin-dir (personas + skills/*),
 * --append-system-prompt-file (soul.md, meta.md),
 * --print, --output-format stream-json, --verbose, --dangerously-skip-permissions
 */
export function buildCommonArgs(personaDir: string): string[] {
  const personasDir = join(personaDir, 'personas');
  const skillsDir = join(personaDir, 'skills');

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--add-dir', personaDir,
    '--plugin-dir', personasDir,
  ];

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
export function buildRoleArgs(role: string, personaDir: string): string[] {
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
 * 统一 spawn Claude CLI 进程。
 * - foreground 模式：通过 sh -c 做 FIFO 管道重定向 (Director)
 * - background 模式：stdout pipe 用于读取 stream-json 输出 (子角色)
 */
export function spawnPersona(options: PersonaSpawnOptions): SpawnResult {
  const args = [
    ...buildCommonArgs(options.personaDir),
    ...buildRoleArgs(options.role, options.personaDir),
  ];

  // foreground (Director) 专用参数
  if (options.mode === 'foreground') {
    args.push('--input-format', 'stream-json', '--bare', '--effort', 'max');
    if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath);
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.sessionName) args.push('--name', options.sessionName);
  }

  // background (子角色) 专用参数
  if (options.mode === 'background') {
    args.push('--bare');
    if (options.prompt) args.push('-p', options.prompt);
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
    const cmd = argsToShellCmd(options.claudePath, args);
    child = spawn('sh', ['-c', `${cmd} < "${options.pipeIn}" > "${options.pipeOut}"`], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      cwd: options.personaDir,
      env: childEnv,
    });
  } else {
    // background：stdout pipe 用于读取 stream-json 输出
    child = spawn(options.claudePath, args, {
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

import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync, mkdirSync } from 'fs';
import { join, resolve, extname, relative, dirname, normalize, basename } from 'path';
import { homedir } from 'os';
import type { IncomingMessage, MessagingClient } from './messaging/messaging.js';
import type { DirectorPool } from './director-pool.js';
import type { AssistantTurnEvent, DirectorToolCall } from './director-session-adapter/index.js';
import { parseConversationLog, parseConversationLogFiles, parseSessionsFiles, parseTaskLog } from './log-parser.js';

import type { SessionBridge } from './session-bridge.js';
import type { MessageQueue } from './queue.js';
import { defaultConfigPath, resolveAgentProvider, type Config } from './config.js';
import type { TaskRunner } from './task/task-runner.js';
import { createTask, getTask, listTasks, updateTask, cancelTask as cancelTaskInDb, getState, setState, previewTaskCleanup, cleanupTaskHistory, type TaskCleanupStatus, type CreateTaskInput, createCronJob, getCronJob, listCronJobs, updateCronJob, deleteCronJob, toggleCronJob, localNow, type CreateCronJobInput, type CronJob, getWorkspaceSessionStats, listSessionsFromDb, setSessionNameInDb } from './task/task-store.js';
import { listPersonaRoles, buildPersonaPromptBundle, sessionLinkKey, upsertSessionLink, type PersonaSessionLink } from './persona-orchestration.js';
import { getLogDir } from './logger.js';
import { resolveCronMessage } from './prompt-loader.js';
import { extractBashCommand, isBashAction, runBashAction } from './task/shell-bash.js';
import { CodexThreadInjector } from './codex-thread-injector.js';

/** Minimal WebSocket interface — matches Bun.ServerWebSocket surface used here */
interface WsConnection {
  send(data: string): void;
}

interface ConsoleProject {
  id: string;
  name: string;
  path: string;
  source: 'process' | 'provider' | 'persona';
}

interface ConsoleWorkspace {
  id: string;
  name: string;
  path: string;
  source: 'main' | 'memory';
  cwd?: string;
  agent?: string;
  directorLabel?: string;
  routingKey?: string;
  groupName?: string;
  sessionId?: string | null;
  sessionName?: string | null;
  alive?: boolean;
  lastActiveAt?: number;
  localSessionCount?: number;
  localMessageCount?: number;
  lastMessageAt?: string;
}

interface WorkspaceConfig {
  cwd?: string;
  agent?: string;
}

function getWorkspaceConfig(name: string): WorkspaceConfig | null {
  return getState<WorkspaceConfig>(`workspace:config:${name}`);
}

function setWorkspaceConfig(name: string, wsConfig: WorkspaceConfig): void {
  setState(`workspace:config:${name}`, wsConfig);
}

// Shell 启动时间，用于计算 uptime
const startedAt = Date.now();

type DirectorLogTarget = {
  label: string;
  inputLogs: string[];
  outputLogs: string[];
};

function safeDirectorLabel(label: string | null | undefined): string {
  const normalized = (label || 'main').trim();
  return /^[a-zA-Z0-9._-]+$/.test(normalized) ? normalized : 'main';
}

function listDirectorLogs(label: string, kind: 'input' | 'output'): string[] {
  const dir = join(getLogDir(), label);
  if (!existsSync(dir)) return [];
  const pattern = new RegExp('^' + kind + '-\\d{8}\\.log$');
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function resolveDirectorLogTarget(label: string | null | undefined, director: SessionBridge, pool?: DirectorPool): DirectorLogTarget {
  const requested = safeDirectorLabel(label);
  if (requested === 'main') {
    const inputLogs = listDirectorLogs('main', 'input');
    const outputLogs = listDirectorLogs('main', 'output');
    return {
      label: 'main',
      inputLogs: inputLogs.length ? inputLogs : [director.inputLogPath],
      outputLogs: outputLogs.length ? outputLogs : [director.outputLogPath],
    };
  }

  // Try matching as pool director label
  const entry = pool?.getPoolStatus().find((item) => item.label === requested);
  const active = entry ? pool?.get(entry.routingKey) : undefined;

  if (active) {
    // Use workspace name path (new), plus old label path for compat
    const wsName = active.bridge.workspaceName;
    const inputLogs = deduplicateLogs(listDirectorLogs(wsName, 'input'), listDirectorLogs(active.bridge.label, 'input'));
    const outputLogs = deduplicateLogs(listDirectorLogs(wsName, 'output'), listDirectorLogs(active.bridge.label, 'output'));
    return {
      label: active.bridge.label,
      inputLogs: inputLogs.length ? inputLogs : [active.bridge.inputLogPath],
      outputLogs: outputLogs.length ? outputLogs : [active.bridge.outputLogPath],
    };
  }

  // Closed/unknown director: try workspace name path + old label path
  const closedLabel = entry?.label ?? requested;
  const groupName = entry?.groupName;
  const inputLogs = groupName
    ? deduplicateLogs(listDirectorLogs(groupName, 'input'), listDirectorLogs(closedLabel, 'input'))
    : listDirectorLogs(closedLabel, 'input');
  const outputLogs = groupName
    ? deduplicateLogs(listDirectorLogs(groupName, 'output'), listDirectorLogs(closedLabel, 'output'))
    : listDirectorLogs(closedLabel, 'output');
  return { label: closedLabel, inputLogs, outputLogs };
}

/** Merge log file lists from new (workspace name) and old (label) paths, deduplicating by basename. */
function deduplicateLogs(primary: string[], secondary: string[]): string[] {
  if (secondary.length === 0) return primary;
  const seen = new Set(primary.map((p) => basename(p)));
  const merged = [...primary];
  for (const s of secondary) {
    if (!seen.has(basename(s))) {
      merged.push(s);
      seen.add(basename(s));
    }
  }
  return merged.sort();
}

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
  director: SessionBridge,
  queue: MessageQueue,
  config: Config,
  taskRunner?: TaskRunner,
  messaging?: MessagingClient,
  metrics?: MetricsCollector,
  pool?: DirectorPool,
): MessagingClient {
  const port = config.console.port;
  const token = config.console.token;
  const publicDir = join(import.meta.dir, 'public');
  const htmlPath = join(publicDir, 'index.html');
  const v2Dir = resolve(import.meta.dir, '..', 'web-v2', 'dist');
  const v2HtmlPath = join(v2Dir, 'index.html');

  // Web chat 消息处理
  const chatHandlers: Array<(msg: IncomingMessage) => Promise<void> | void> = [];
  // messageId → { ws, createdAt } 连接，用于路由回复
  const messageWsMap = new Map<string, { ws: WsConnection; createdAt: number }>();

  // 每 60s 清理超过 5 分钟未回复的 entries，防止内存泄漏
  const MESSAGE_WS_TTL = 5 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of messageWsMap) {
      if (now - entry.createdAt > MESSAGE_WS_TTL) messageWsMap.delete(id);
    }
  }, 60_000);

  if (!config.console.enabled) {
    console.log('[console] Web console disabled by config');
    // 返回一个空的 MessagingClient stub
    return {
      start() {},
      onMessage(handler) { chatHandlers.push(handler); },
      async reply() {},
      async sendMessage() { return null; },
      async addReaction() {},
      async uploadAndReplyImage() {},
      async uploadAndReplyFile() {},
      async uploadAndSendImage() { return null; },
      async uploadAndSendFile() { return null; },
      getLastChatId() { return null; },
      getConnectionStatus() { return 'disconnected' as const; },
    };
  }

  /** 检查请求是否携带有效 token，未配置 token 时放行 */
  function checkAuth(req: Request): Response | null {
    if (!token) return null; // 未配置 token，放行
    // 支持 Bearer token (HTTP API) 和 query param ?token=xxx (WebSocket)
    const auth = req.headers.get('Authorization');
    if (auth === `Bearer ${token}`) return null;
    const url = new URL(req.url);
    if (url.searchParams.get('token') === token) return null;
    return new Response('Unauthorized', { status: 401 });
  }

  // 活跃的 WebSocket 连接集合
  const clients = new Set<WsConnection>();

  function expandConsolePath(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return path;
  }

  function buildWorkContext(): { projects: ConsoleProject[]; workspaces: ConsoleWorkspace[]; activeProjectId?: string; activeWorkspaceId?: string } {
    const projects = new Map<string, ConsoleProject>();
    const addProject = (project: ConsoleProject) => {
      const path = resolve(expandConsolePath(project.path));
      projects.set(path, { ...project, path });
    };

    addProject({
      id: 'process-cwd',
      name: basename(process.cwd()) || 'current',
      path: process.cwd(),
      source: 'process',
    });

    for (const [name, provider] of Object.entries(config.agents.providers)) {
      if (!provider.cwd) continue;
      const path = resolve(expandConsolePath(provider.cwd));
      addProject({
        id: `provider-${name}`,
        name: basename(path) || name,
        path,
        source: 'provider',
      });
    }

    addProject({
      id: 'persona-dir',
      name: basename(config.director.persona_dir) || 'persona',
      path: config.director.persona_dir,
      source: 'persona',
    });

    const mainStatus = director.getStatus();
    const poolStatus = pool?.getPoolStatus() ?? [];
    const safeGroupName = (name: string) => name.replace(/[\/\\:*?"<>|]/g, '_');
    const directorForWorkspace = (workspaceName: string): Partial<ConsoleWorkspace> => {
      const match = poolStatus.find((entry) => {
        const safeName = safeGroupName(entry.groupName);
        return workspaceName === safeName
          || workspaceName === entry.label
          || workspaceName === `${entry.label}-${safeName}`
          || workspaceName.startsWith(`${entry.label}-`);
      });
      if (!match) return {};
      return {
        directorLabel: match.label,
        routingKey: match.routingKey,
        groupName: match.groupName,
        sessionId: match.directorStatus?.sessionId ?? null,
        sessionName: match.directorStatus?.sessionName ?? null,
        alive: match.directorStatus?.alive ?? false,
        lastActiveAt: match.lastActiveAt,
      };
    };
    const legacyDirectorForWorkspace = (workspaceName: string): Partial<ConsoleWorkspace> => {
      const match = workspaceName.match(/^([0-9a-f]{8})-(.+)$/i);
      if (!match) return {};
      const [, label, groupName] = match;
      return {
        directorLabel: label,
        groupName,
        sessionId: null,
        sessionName: null,
        alive: false,
      };
    };
    const unlinkedDirectorForWorkspace = (workspaceName: string): Partial<ConsoleWorkspace> => ({
      directorLabel: `workspace-${createHash('sha256').update(workspaceName).digest('hex').slice(0, 8)}`,
      groupName: workspaceName,
      sessionId: null,
      sessionName: null,
      alive: false,
    });
    const localHistoryForWorkspace = (workspaceName: string): Partial<ConsoleWorkspace> => {
      const stats = getWorkspaceSessionStats(workspaceName);
      if (stats.sessionCount === 0) return {};
      return {
        localSessionCount: stats.sessionCount,
        localMessageCount: stats.messageCount,
        lastMessageAt: stats.lastMessageAt ?? undefined,
      };
    };

    const workspaces: ConsoleWorkspace[] = [{
      id: 'main',
      name: 'Main director',
      path: join(config.director.persona_dir, 'daily', 'state.md'),
      source: 'main',
      directorLabel: 'main',
      sessionId: mainStatus.sessionId ?? null,
      sessionName: mainStatus.sessionName ?? null,
      alive: mainStatus.alive,
      ...localHistoryForWorkspace('main'),
    }];

    const memoryRoot = join(config.director.persona_dir, 'workspaces');
    if (existsSync(memoryRoot)) {
      const allNames = readdirSync(memoryRoot);
      const nameSet = new Set(allNames);
      for (const name of allNames) {
        const workspacePath = join(memoryRoot, name);
        try {
          if (!statSync(workspacePath).isDirectory()) continue;
          // Skip legacy {hash}-{name} directories when the migrated {name} directory exists
          const legacyMatch = name.match(/^[0-9a-f]{8}-(.+)$/i);
          if (legacyMatch && nameSet.has(legacyMatch[1])) continue;
          const routing = {
            ...unlinkedDirectorForWorkspace(name),
            ...legacyDirectorForWorkspace(name),
            ...directorForWorkspace(name),
          };
          const wsConfig = getWorkspaceConfig(name);
          const wsName = routing.groupName ?? name;
          workspaces.push({
            id: `memory-${name}`,
            name,
            path: join(workspacePath, 'context.md'),
            source: 'memory',
            cwd: wsConfig?.cwd,
            agent: wsConfig?.agent,
            ...routing,
            ...localHistoryForWorkspace(wsName),
          });
        } catch {
          // Best effort for UI context.
        }
      }
    }

    workspaces.sort((a, b) => {
      if (a.id === 'main') return -1;
      if (b.id === 'main') return 1;
      const aHistory = (a.localMessageCount ?? 0) > 0 ? 1 : 0;
      const bHistory = (b.localMessageCount ?? 0) > 0 ? 1 : 0;
      if (aHistory !== bHistory) return bHistory - aHistory;
      const aActive = a.alive ? 1 : 0;
      const bActive = b.alive ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      const aTime = a.lastActiveAt ?? (a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0);
      const bTime = b.lastActiveAt ?? (b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0);
      if (aTime !== bTime) return bTime - aTime;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

    return {
      projects: [...projects.values()],
      workspaces,
      activeProjectId: [...projects.values()][0]?.id,
      activeWorkspaceId: workspaces[0]?.id,
    };
  }

  function sanitizeWorkspaceName(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const name = input
      .trim()
      .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
      .trim();
    if (!name || name === '.' || name === '..') return null;
    return name;
  }

  function createWorkspace(input: unknown, cwd?: string, agent?: string): ConsoleWorkspace {
    const name = sanitizeWorkspaceName(input);
    if (!name) {
      throw new Error('Workspace name is required');
    }

    let resolvedCwd: string | undefined;
    if (cwd && typeof cwd === 'string') {
      resolvedCwd = resolve(expandConsolePath(cwd.trim()));
      if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
        throw new Error(`Invalid cwd: directory does not exist: ${resolvedCwd}`);
      }
    }

    const memoryRoot = join(config.director.persona_dir, 'workspaces');
    const workspacePath = join(memoryRoot, name);
    const contextPath = join(workspacePath, 'context.md');

    mkdirSync(workspacePath, { recursive: true });
    if (!existsSync(contextPath)) {
      writeFileSync(contextPath, '');
    }

    const wsConfig: WorkspaceConfig = {};
    if (resolvedCwd) wsConfig.cwd = resolvedCwd;
    if (agent && typeof agent === 'string') wsConfig.agent = agent.trim();
    if (Object.keys(wsConfig).length > 0) {
      setWorkspaceConfig(name, wsConfig);
    }

    return {
      id: `memory-${name}`,
      name,
      path: contextPath,
      source: 'memory',
      cwd: resolvedCwd,
      agent: wsConfig.agent,
    };
  }

  // 构建状态快照
  function buildSnapshot() {
    const ds = director.getStatus();
    const now = Date.now();

    // System status
    const messagingStatus = messaging?.getConnectionStatus() ?? 'disconnected';
    let systemStatus: 'healthy' | 'degraded' | 'error';
    if (messagingStatus === 'connected' && ds.alive) {
      systemStatus = 'healthy';
    } else if (messagingStatus === 'connected' || ds.alive) {
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

    // Context — use contextWindow from modelUsage as denominator (falls back to flushContextLimit)
    const contextLimit = ds.contextWindow > 0 ? ds.contextWindow : ds.flushContextLimit;
    const displayTokens = ds.contextMetricsLive ? ds.lastInputTokens : null;
    const tokenPercent = contextLimit > 0 && displayTokens != null
      ? Math.round((ds.lastInputTokens / contextLimit) * 100)
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
          messaging: messagingStatus,
          directorAlive: ds.alive,
          directorPid: ds.pid,
          sessionId: ds.sessionId,
          sessionName: ds.sessionName,
          directorAgentName: ds.agentName,
          directorAgentType: ds.agentType,
          personaRole: ds.personaRole,
          restartCount: ds.restartCount,
          recentRestartCount: ds.recentRestartCount,
          recentRestartAt: ds.recentRestartAt,
          lastRestartAt: ds.lastRestartAt,
          lastRestartReason: ds.lastRestartReason,
          lastCrashAt: ds.lastCrashAt,
          lastCrashReason: ds.lastCrashReason,
        },
        activity,
        context: {
          tokens: displayTokens,
          observedTokens: ds.lastInputTokens,
          contextTokens: ds.contextTokens,
          limit: contextLimit,
          percent: tokenPercent,
          live: ds.contextMetricsLive,
          lastFlushAgoMs: now - ds.lastFlushAt,
          flushLimit: ds.flushContextLimit,
          contextWindow: ds.contextWindow,
          autoFlushDisabled: ds.autoFlushDisabled,
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
        pool: pool ? pool.getPoolStatus().map((entry) => ({
          routingKey: entry.routingKey,
          groupName: entry.groupName,
          label: entry.label,
          lastActiveAt: entry.lastActiveAt,
          queueLength: entry.queueLength,
          queue: entry.queue,
          activity: entry.directorStatus?.activityState ?? null,
          alive: entry.directorStatus?.alive ?? false,
          currentMessage: entry.directorStatus?.currentMessagePreview && entry.directorStatus?.currentMessageStartedAt ? {
            preview: entry.directorStatus.currentMessagePreview,
            elapsedMs: now - entry.directorStatus.currentMessageStartedAt,
            startedAt: entry.directorStatus.currentMessageStartedAt,
          } : null,
          pid: entry.directorStatus?.pid ?? null,
          sessionId: entry.directorStatus?.sessionId ?? null,
          directorAgentName: entry.directorAgentName ?? entry.directorStatus?.agentName ?? null,
          directorAgentType: entry.directorStatus?.agentType ?? null,
          personaRole: entry.personaRole ?? entry.directorStatus?.personaRole ?? null,
          restartCount: entry.directorStatus?.restartCount ?? 0,
          recentRestartCount: entry.directorStatus?.recentRestartCount ?? 0,
          recentRestartAt: entry.directorStatus?.recentRestartAt ?? [],
          lastRestartAt: entry.directorStatus?.lastRestartAt ?? null,
          lastRestartReason: entry.directorStatus?.lastRestartReason ?? null,
          lastCrashAt: entry.directorStatus?.lastCrashAt ?? null,
          lastCrashReason: entry.directorStatus?.lastCrashReason ?? null,
          closed: entry.closed ?? false,
          closedAt: entry.closedAt ?? null,
          closedReason: entry.closedReason ?? null,
          context: entry.directorStatus ? {
            tokens: entry.directorStatus.contextMetricsLive ? entry.directorStatus.lastInputTokens : null,
            observedTokens: entry.directorStatus.lastInputTokens,
            contextTokens: entry.directorStatus.contextTokens,
            limit: entry.directorStatus.contextWindow > 0 ? entry.directorStatus.contextWindow : entry.directorStatus.flushContextLimit,
            percent: entry.directorStatus.contextMetricsLive && (entry.directorStatus.contextWindow > 0 ? entry.directorStatus.contextWindow : entry.directorStatus.flushContextLimit) > 0
              ? Math.round((entry.directorStatus.lastInputTokens / (entry.directorStatus.contextWindow > 0 ? entry.directorStatus.contextWindow : entry.directorStatus.flushContextLimit)) * 100)
              : 0,
            live: entry.directorStatus.contextMetricsLive,
            lastFlushAgoMs: now - entry.directorStatus.lastFlushAt,
            lastFlushAt: entry.directorStatus.lastFlushAt,
            flushLimit: entry.directorStatus.flushContextLimit,
            contextWindow: entry.directorStatus.contextWindow,
            autoFlushDisabled: entry.directorStatus.autoFlushDisabled,
          } : null,
        })) : [],
      },
    };
  }

  type WorkbenchFileKind = 'markdown' | 'text' | 'image' | 'file';

  interface WorkbenchFile {
    scope: 'outbox' | 'attachments' | 'task-results';
    path: string;
    relativePath: string;
    name: string;
    ext: string;
    size: number;
    mtimeMs: number;
    kind: WorkbenchFileKind;
    taskId?: string;
    description?: string;
    sourceKind: 'outbox' | 'attachment' | 'task-result';
    sourceLabel: string;
    taskStatus?: string;
    taskRole?: string;
    taskAgent?: string | null;
    sourceDirector?: string | null;
    taskCreatedAt?: string;
    taskCompletedAt?: string | null;
    taskParentSessionId?: string;
    taskParentSessionName?: string;
    taskParentDirector?: string;
    taskParentGroup?: string;
    taskParentStatus?: string;
  }

  function isInside(root: string, candidate: string): boolean {
    const resolvedRoot = resolve(root);
    const resolvedCandidate = resolve(candidate);
    return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + '/');
  }

  function fileKind(path: string): WorkbenchFileKind {
    const ext = extname(path).toLowerCase();
    if (['.md', '.markdown'].includes(ext)) return 'markdown';
    if (['.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv'].includes(ext)) return 'text';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico'].includes(ext)) return 'image';
    return 'file';
  }

  function imageMimeType(path: string): string {
    const ext = extname(path).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.tiff') return 'image/tiff';
    if (ext === '.ico') return 'image/x-icon';
    return 'image/png';
  }

  function downloadMimeType(path: string): string {
    const ext = extname(path).toLowerCase();
    if (['.md', '.markdown'].includes(ext)) return 'text/markdown; charset=utf-8';
    if (['.txt', '.log'].includes(ext)) return 'text/plain; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.csv') return 'text/csv; charset=utf-8';
    if (['.yaml', '.yml'].includes(ext)) return 'application/yaml; charset=utf-8';
    if (ext === '.tsv') return 'text/tab-separated-values; charset=utf-8';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico'].includes(ext)) return imageMimeType(path);
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.zip') return 'application/zip';
    return 'application/octet-stream';
  }

  function contentDispositionForPath(path: string): string {
    const rawName = (path.split('/').pop() || 'download').replace(/[\r\n"]/g, '_');
    const asciiName = rawName.replace(/[^\x20-\x7e]/g, '_') || 'download';
    return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`;
  }

  function safeAttachmentFileName(name: string): string {
    const raw = (name.split(/[\\/]/).pop() || 'attachment').trim();
    const cleaned = raw
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[:"<>|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .slice(0, 120)
      .trim();
    return cleaned || 'attachment';
  }

  function attachmentUploadDay(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  function workbenchAttachmentFile(path: string): WorkbenchFile {
    const attachmentsRoot = resolve(config.director.persona_dir, 'attachments');
    const stat = statSync(path);
    return {
      scope: 'attachments',
      path,
      relativePath: relative(attachmentsRoot, path),
      name: path.split('/').pop() ?? 'attachment',
      ext: extname(path).toLowerCase(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      kind: fileKind(path),
      sourceKind: 'attachment',
      sourceLabel: 'Uploaded attachment',
    };
  }

  function collectFiles(root: string, scope: WorkbenchFile['scope'], depth = 4): WorkbenchFile[] {
    const files: WorkbenchFile[] = [];
    if (!existsSync(root)) return files;

    function visit(dir: string, remainingDepth: number): void {
      if (remainingDepth < 0) return;
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (!isInside(root, path)) continue;
        if (entry.isDirectory()) {
          visit(path, remainingDepth - 1);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = statSync(path);
          files.push({
            scope,
            path,
            relativePath: relative(root, path),
            name: entry.name,
            ext: extname(path).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            kind: fileKind(path),
            sourceKind: scope === 'attachments' ? 'attachment' : 'outbox',
            sourceLabel: scope === 'attachments' ? 'Uploaded attachment' : 'Outbox artifact',
          });
        } catch {
          // ignore unreadable files
        }
      }
    }

    visit(root, depth);
    return files;
  }

  function taskExtraString(task: ReturnType<typeof listTasks>[number], key: string): string | undefined {
    const value = task.extra?.[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  function applyTaskSourceMetadata(file: WorkbenchFile, task: ReturnType<typeof listTasks>[number]): void {
    file.taskId = task.id;
    file.description = file.description ?? task.description;
    file.sourceKind = 'task-result';
    file.sourceLabel = `Task ${task.id}`;
    file.taskStatus = task.status;
    file.taskRole = task.role;
    file.taskAgent = task.agent;
    file.sourceDirector = task.source_director;
    file.taskCreatedAt = task.created_at;
    file.taskCompletedAt = task.completed_at;
    file.taskParentSessionId = taskExtraString(task, 'parent_session_id') ?? taskExtraString(task, 'parent_codex_thread_id');
    file.taskParentSessionName = taskExtraString(task, 'parent_session_name');
    file.taskParentDirector = taskExtraString(task, 'parent_director_label') ?? task.source_director ?? undefined;
    file.taskParentGroup = taskExtraString(task, 'parent_group_name');
    file.taskParentStatus = taskExtraString(task, 'parent_director_status');
  }

  function listWorkbenchFiles(scope?: string): WorkbenchFile[] {
    const personaDir = config.director.persona_dir;
    const outboxRoot = resolve(personaDir, 'outbox');
    const attachmentsRoot = resolve(personaDir, 'attachments');
    const byPath = new Map<string, WorkbenchFile>();
    const taskResultByPath = new Map<string, ReturnType<typeof listTasks>[number]>();

    for (const task of listTasks({ limit: 500 })) {
      if (task.result_file) taskResultByPath.set(resolve(task.result_file), task);
    }

    if (!scope || scope === 'outbox') {
      for (const file of collectFiles(outboxRoot, 'outbox')) byPath.set(file.path, file);
    }
    if (!scope || scope === 'attachments') {
      for (const file of collectFiles(attachmentsRoot, 'attachments')) byPath.set(file.path, file);
    }
    if (!scope || scope === 'task-results') {
      for (const [path, task] of taskResultByPath.entries()) {
        if (!existsSync(path)) continue;
        try {
          const stat = statSync(path);
          byPath.set(path, {
            scope: 'task-results',
            path,
            relativePath: relative(outboxRoot, path),
            name: path.split('/').pop() ?? task.id,
            ext: extname(path).toLowerCase(),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            kind: fileKind(path),
            sourceKind: 'task-result',
            sourceLabel: `Task ${task.id}`,
          });
          applyTaskSourceMetadata(byPath.get(path)!, task);
        } catch {
          // ignore unreadable task result
        }
      }
    }

    for (const [path, task] of taskResultByPath.entries()) {
      const existing = byPath.get(path);
      if (!existing) continue;
      applyTaskSourceMetadata(existing, task);
    }

    return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 300);
  }

  function isAllowedWorkbenchFile(path: string): boolean {
    const personaDir = config.director.persona_dir;
    const roots = [
      resolve(personaDir, 'outbox'),
      resolve(personaDir, 'attachments'),
    ];
    if (roots.some((root) => isInside(root, path))) return true;
    return listTasks({ limit: 500 }).some((task) => task.result_file && resolve(task.result_file) === path);
  }

  function isAllowedAttachmentPath(path: string): boolean {
    if (isAllowedWorkbenchFile(path)) return true;
    const allowedRoots = [
      '/tmp',
      resolve(homedir(), '.persona/outbox'),
    ];
    return allowedRoots.some((root) => isInside(root, path));
  }

  interface LogSource {
    id: string;
    label: string;
    path: string;
    size: number;
    mtimeMs: number;
    group: string;
  }

  function readLogTail(path: string, maxBytes: number): string {
    if (!existsSync(path)) return '';
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return '';
    const readSize = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, readSize, stat.size - readSize);
    } finally {
      closeSync(fd);
    }
    const raw = buf.toString('utf-8');
    if (readSize < stat.size) {
      const firstNewline = raw.indexOf('\n');
      return firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
    }
    return raw;
  }

  function collectLogSources(): LogSource[] {
    const root = resolve(getLogDir());
    const sources: LogSource[] = [];

    function visit(dir: string, depth: number): void {
      if (depth < 0) return;
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (!isInside(root, path)) continue;
        if (entry.isDirectory()) {
          visit(path, depth - 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
        try {
          const stat = statSync(path);
          const rel = relative(root, path);
          const group = rel.includes('/') ? rel.split('/')[0] : 'shell';
          sources.push({
            id: rel,
            label: rel,
            path,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            group,
          });
        } catch {
          // ignore unreadable logs
        }
      }
    }

    visit(root, 2);
    return sources.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200);
  }

  type GlobalSearchKind = 'message' | 'task' | 'log';
  interface GlobalSearchResult {
    kind: GlobalSearchKind;
    title: string;
    preview: string;
    timestamp?: number;
    director?: string;
    sessionId?: string;
    taskId?: string;
    logSourceId?: string;
    logPath?: string;
    line?: number;
    status?: string;
    score: number;
  }

  function searchScore(text: string, query: string): number {
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    if (!needle) return 0;
    let score = 0;
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      score += 10;
      index = haystack.indexOf(needle, index + needle.length);
    }
    if (haystack.startsWith(needle)) score += 5;
    return score;
  }

  function searchPreview(text: string, query: string, max = 240): string {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const idx = clean.toLowerCase().indexOf(query.toLowerCase());
    const start = idx >= 0 ? Math.max(0, idx - 80) : 0;
    const slice = clean.slice(start, start + max);
    return `${start > 0 ? '...' : ''}${slice}${start + max < clean.length ? '...' : ''}`;
  }

  function buildGlobalSearch(query: string, limit: number): { query: string; results: GlobalSearchResult[]; scanned: { messages: number; tasks: number; logs: number } } {
    const q = query.trim();
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 40, 100));
    const results: GlobalSearchResult[] = [];
    const scanned = { messages: 0, tasks: 0, logs: 0 };
    if (!q) return { query: q, results, scanned };

    const directors: Array<{ label: string; bridge: SessionBridge }> = [{ label: 'main', bridge: director }];
    if (pool) {
      for (const entry of pool.getPoolStatus()) {
        const poolEntry = pool.get(entry.routingKey);
        if (poolEntry) directors.push({ label: entry.label, bridge: poolEntry.bridge });
      }
    }

    for (const item of directors) {
      const messages = parseConversationLog(item.bridge.inputLogPath, item.bridge.outputLogPath, 300);
      scanned.messages += messages.length;
      for (const message of messages) {
        const score = searchScore(message.content, q);
        if (score <= 0) continue;
        results.push({
          kind: 'message',
          title: message.direction === 'in' ? 'User message' : 'Director reply',
          preview: searchPreview(message.content, q),
          timestamp: message.timestamp,
          director: item.label,
          sessionId: message.sessionId,
          score: score + (message.direction === 'in' ? 2 : 1),
        });
      }
    }

    const tasks = listTasks({ limit: 500 });
    scanned.tasks = tasks.length;
    for (const task of tasks) {
      const fields = [
        task.id,
        task.role,
        task.agent ?? '',
        task.description,
        task.prompt,
        task.status,
        task.error ?? '',
        task.result_file ?? '',
        task.source_director ?? '',
      ].join('\n');
      const score = searchScore(fields, q);
      if (score <= 0) continue;
      results.push({
        kind: 'task',
        title: `${task.id} · ${task.role}`,
        preview: searchPreview(task.description || task.prompt || task.error || task.result_file || task.id, q),
        timestamp: Date.parse(task.completed_at || task.started_at || task.created_at),
        director: task.source_director ?? 'main',
        taskId: task.id,
        status: task.status,
        score: score + 3,
      });
    }

    for (const source of collectLogSources().slice(0, 30)) {
      const tail = readLogTail(source.path, 128 * 1024);
      const lines = tail.split('\n');
      scanned.logs += lines.length;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const score = searchScore(line, q);
        if (score <= 0) continue;
        results.push({
          kind: 'log',
          title: source.label,
          preview: searchPreview(line, q),
          timestamp: source.mtimeMs,
          logSourceId: source.id,
          logPath: source.path,
          line: i + 1,
          status: source.group,
          score,
        });
      }
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.timestamp ?? 0) - (a.timestamp ?? 0);
    });
    return { query: q, results: results.slice(0, safeLimit), scanned };
  }

  function resolveLogSource(id: string): string | null {
    const root = resolve(getLogDir());
    const path = resolve(root, id);
    if (!isInside(root, path)) return null;
    if (!path.endsWith('.log')) return null;
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return path;
  }

  function maskValue(value?: string): string | null {
    if (!value) return null;
    if (value.length <= 8) return '***';
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }

  function buildConfigSummary() {
    return {
      console: {
        enabled: config.console.enabled,
        port: config.console.port,
        tokenConfigured: Boolean(config.console.token),
        bind: '127.0.0.1',
      },
      feishu: {
        appId: maskValue(config.feishu.app_id),
        appSecretConfigured: Boolean(config.feishu.app_secret),
        masterId: maskValue(config.feishu.master_id),
        streamingReplyEnabled: config.feishu.streaming_reply_enabled,
        streamUpdateDebounceMs: config.feishu.stream_update_debounce_ms,
        streamMinUpdateChars: config.feishu.stream_min_update_chars,
      },
      director: {
        personaDir: config.director.persona_dir,
        pipeDir: config.director.pipe_dir,
        pidFile: config.director.pid_file,
        timeSyncIntervalMs: config.director.time_sync_interval_ms,
        flushContextLimit: config.director.flush_context_limit,
        flushIntervalMs: config.director.flush_interval_ms,
        quoteMaxLength: config.director.quote_max_length,
      },
      pool: config.pool,
      task: config.task,
      scheduler: config.scheduler,
      logging: config.logging,
      agents: {
        defaults: config.agents.defaults,
        roles: config.agents.roles ?? {},
        providers: Object.fromEntries(
          Object.entries(config.agents.providers).map(([name, provider]) => [
            name,
            {
              type: provider.type,
              command: provider.command,
              model: provider.model ?? null,
              sandbox: provider.sandbox ?? null,
              approval: provider.approval ?? null,
              effort: provider.effort ?? null,
              mcpMode: provider.mcp_mode ?? null,
              search: provider.search ?? false,
              bare: provider.bare ?? false,
              dangerouslySkipPermissions: provider.dangerously_skip_permissions ?? false,
              disableAutoFlush: provider.disable_auto_flush ?? false,
              systemPromptFile: provider.system_prompt_file ?? null,
              agentFile: provider.agent_file ?? null,
              skillsDir: provider.skills_dir ?? null,
              cwd: provider.cwd ?? null,
            },
          ]),
        ),
      },
      safety: {
        localOnly: true,
        dangerousProviders: Object.entries(config.agents.providers)
          .filter(([, provider]) => provider.dangerously_skip_permissions || provider.sandbox === 'danger-full-access' || provider.approval === 'never')
          .map(([name, provider]) => ({
            name,
            dangerouslySkipPermissions: provider.dangerously_skip_permissions ?? false,
            sandbox: provider.sandbox ?? null,
            approval: provider.approval ?? null,
          })),
      },
    };
  }

  interface EnvCheckDefinition {
    name: string;
    command: string;
    source: 'builtin' | 'provider';
  }

  interface EnvCheckResult extends EnvCheckDefinition {
    available: boolean;
    path: string | null;
    version: string | null;
    durationMs: number;
    error: string | null;
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  async function runShell(command: string, timeoutMs = 2500): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const proc = Bun.spawn(['sh', '-lc', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited.catch(() => null),
      ]);
      return {
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function envCheckDefinitions(): EnvCheckDefinition[] {
    const byKey = new Map<string, EnvCheckDefinition>();
    for (const name of ['bun', 'claude', 'codex', 'kimi']) {
      byKey.set(`builtin:${name}`, { name, command: name, source: 'builtin' });
    }
    for (const [name, provider] of Object.entries(config.agents.providers)) {
      if (!provider.command) continue;
      byKey.set(`provider:${name}:${provider.command}`, {
        name: `provider:${name}`,
        command: provider.command,
        source: 'provider',
      });
    }
    return [...byKey.values()];
  }

  async function runEnvChecks(): Promise<EnvCheckResult[]> {
    const checks = envCheckDefinitions();
    return Promise.all(checks.map(async (check) => {
      const started = Date.now();
      const quoted = shellQuote(check.command);
      const which = await runShell(`command -v ${quoted}`, 2200);
      if (which.code !== 0 || !which.stdout) {
        return {
          ...check,
          available: false,
          path: null,
          version: null,
          durationMs: Date.now() - started,
          error: which.timedOut ? 'command lookup timed out' : (which.stderr || which.stdout || 'not found'),
        };
      }
      const version = await runShell(`${quoted} --version 2>&1 | head -n 1`, 3000);
      return {
        ...check,
        available: true,
        path: which.stdout.split('\n')[0] ?? null,
        version: version.stdout || version.stderr || null,
        durationMs: Date.now() - started,
        error: version.timedOut ? 'version check timed out' : null,
      };
    }));
  }

  async function buildDebugBundle() {
    const logSources = collectLogSources().slice(0, 12);
    return {
      generatedAt: new Date().toISOString(),
      console: {
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: Date.now() - startedAt,
      },
      snapshot: buildSnapshot().data,
      config: buildConfigSummary(),
      env: await runEnvChecks(),
      logs: {
        sources: logSources.map(({ id, label, path, size, mtimeMs, group }) => ({ id, label, path, size, mtimeMs, group })),
        tails: Object.fromEntries(logSources.map((source) => [source.id, readLogTail(source.path, 16 * 1024)])),
      },
      audit: readAuditEntries(50),
      tasks: listTasks({ limit: 25 }).map((task) => ({
        id: task.id,
        role: task.role,
        status: task.status,
        description: task.description,
        sourceDirector: task.source_director,
        agent: task.agent,
        createdAt: task.created_at,
        startedAt: task.started_at,
        completedAt: task.completed_at,
        durationMs: task.duration_ms,
        costUsd: task.cost_usd,
        resultFile: task.result_file,
        error: task.error,
      })),
      cronJobs: listCronJobs().slice(0, 50).map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        schedule: job.schedule,
        actionType: job.action_type,
        actionName: job.action_name,
        sourceDirector: job.source_director,
        lastRunAt: job.last_run_at,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      })),
    };
  }

  function normalizedErrorKey(message: string): string {
    return message
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
      .replace(/\bT-\d{4}-\d{2}-\d{3}\b/g, '<task>')
      .replace(/\bC-\d{4}-\d{2}-\d{3}\b/g, '<cron>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\b\d+\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function looksLikeErrorLine(line: string): boolean {
    return /\b(error|failed|failure|exception|fatal|traceback|uncaught|timeout|timed out|enoent|eacces)\b/i.test(line);
  }

  function pushErrorAggregate(
    map: Map<string, { message: string; count: number; lastAt: number; sources: Set<string> }>,
    message: string,
    source: string,
    at?: number,
  ): void {
    const clean = message.trim();
    if (!clean) return;
    const key = normalizedErrorKey(clean) || clean.slice(0, 180);
    const current = map.get(key) ?? { message: clean.slice(0, 300), count: 0, lastAt: 0, sources: new Set<string>() };
    current.count += 1;
    current.lastAt = Math.max(current.lastAt, at ?? Date.now());
    current.sources.add(source);
    map.set(key, current);
  }

  function isoDay(value: string | null | undefined): string {
    if (!value) return 'unknown';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value.slice(0, 10) || 'unknown';
    return new Date(parsed).toISOString().slice(0, 10);
  }

  function pct(numerator: number, denominator: number): number {
    if (denominator <= 0) return 0;
    return Math.round((numerator / denominator) * 1000) / 10;
  }

  function buildRateStats(tasks: ReturnType<typeof listTasks>, keyFn: (task: ReturnType<typeof listTasks>[number]) => string) {
    const map = new Map<string, { name: string; total: number; completed: number; failed: number; running: number; costUsd: number; avgDurationMs: number; durationCount: number; lastTaskAt: string | null }>();
    for (const task of tasks) {
      const name = keyFn(task) || 'unknown';
      const current = map.get(name) ?? { name, total: 0, completed: 0, failed: 0, running: 0, costUsd: 0, avgDurationMs: 0, durationCount: 0, lastTaskAt: null };
      current.total += 1;
      if (task.status === 'completed') current.completed += 1;
      else if (task.status === 'failed') current.failed += 1;
      else current.running += 1;
      current.costUsd += task.cost_usd ?? 0;
      if (task.duration_ms != null) {
        current.durationCount += 1;
        current.avgDurationMs = Math.round(((current.avgDurationMs * Math.max(0, current.durationCount - 1)) + task.duration_ms) / Math.max(1, current.durationCount));
      }
      const taskAt = task.completed_at ?? task.started_at ?? task.created_at;
      if (taskAt && (!current.lastTaskAt || Date.parse(taskAt) > Date.parse(current.lastTaskAt))) {
        current.lastTaskAt = taskAt;
      }
      map.set(name, current);
    }
    return [...map.values()]
      .map((item) => ({
        ...item,
        successRate: pct(item.completed, item.completed + item.failed),
        failureRate: pct(item.failed, item.completed + item.failed),
        costUsd: Math.round(item.costUsd * 1_000_000) / 1_000_000,
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 16);
  }

  function buildObservabilityDiagnostics() {
    const tasks = listTasks({ limit: 500 });
    const cronJobs = listCronJobs();
    const errorMap = new Map<string, { message: string; count: number; lastAt: number; sources: Set<string> }>();

    for (const err of metrics?.recentErrors ?? []) {
      pushErrorAggregate(errorMap, err.message, 'runtime', err.timestamp);
    }
    for (const task of tasks) {
      if (task.status === 'failed') {
        pushErrorAggregate(errorMap, task.error || task.description || task.id, `task:${task.id}`, Date.parse(task.completed_at || task.started_at || task.created_at));
      }
    }
    for (const source of collectLogSources().slice(0, 20)) {
      const content = readLogTail(source.path, 64 * 1024);
      const lines = content.split('\n');
      for (let i = Math.max(0, lines.length - 300); i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (line && looksLikeErrorLine(line)) pushErrorAggregate(errorMap, line, `log:${source.label}`, source.mtimeMs);
      }
    }

    const byDay = new Map<string, { day: string; total: number; completed: number; failed: number; running: number; costUsd: number; avgDurationMs: number }>();
    for (const task of tasks) {
      const day = isoDay(task.created_at);
      const current = byDay.get(day) ?? { day, total: 0, completed: 0, failed: 0, running: 0, costUsd: 0, avgDurationMs: 0 };
      current.total += 1;
      if (task.status === 'completed') current.completed += 1;
      else if (task.status === 'failed') current.failed += 1;
      else current.running += 1;
      current.costUsd += task.cost_usd ?? 0;
      if (task.duration_ms != null) {
        current.avgDurationMs = Math.round(((current.avgDurationMs * Math.max(0, current.total - 1)) + task.duration_ms) / current.total);
      }
      byDay.set(day, current);
    }

    const cronRuns = new Map<string, { id: string; name: string; total: number; completed: number; failed: number; running: number; lastRunAt: string | null }>();
    for (const job of cronJobs) {
      cronRuns.set(job.id, { id: job.id, name: job.name, total: 0, completed: 0, failed: 0, running: 0, lastRunAt: job.last_run_at });
    }
    for (const task of tasks) {
      const cronJobId = (task.extra as Record<string, unknown> | null)?.cronJobId as string | undefined;
      if (!cronJobId) continue;
      const job = cronRuns.get(cronJobId) ?? { id: cronJobId, name: cronJobId, total: 0, completed: 0, failed: 0, running: 0, lastRunAt: null };
      job.total += 1;
      if (task.status === 'completed') job.completed += 1;
      else if (task.status === 'failed') job.failed += 1;
      else job.running += 1;
      cronRuns.set(cronJobId, job);
    }

    const total = tasks.length;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const failed = tasks.filter((task) => task.status === 'failed').length;
    const running = total - completed - failed;

    return {
      generatedAt: new Date().toISOString(),
      window: { tasks: total, logs: Math.min(20, collectLogSources().length) },
      health: {
        totalTasks: total,
        completed,
        failed,
        running,
        successRate: pct(completed, completed + failed),
        totalCostUsd: tasks.reduce((sum, task) => sum + (task.cost_usd ?? 0), 0),
        avgDurationMs: Math.round(tasks.reduce((sum, task) => sum + (task.duration_ms ?? 0), 0) / Math.max(1, tasks.filter((task) => task.duration_ms != null).length)),
      },
      errors: [...errorMap.values()]
        .map((item) => ({
          message: item.message,
          count: item.count,
          lastAt: item.lastAt,
          sources: [...item.sources].slice(0, 6),
        }))
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
        .slice(0, 20),
      providerStats: buildRateStats(tasks, (task) => task.agent || 'default'),
      roleStats: buildRateStats(tasks, (task) => task.role || 'unknown'),
      cronStats: [...cronRuns.values()]
        .map((item) => ({ ...item, failureRate: pct(item.failed, item.completed + item.failed) }))
        .sort((a, b) => b.failureRate - a.failureRate || b.total - a.total)
        .slice(0, 20),
      trends: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    };
  }

  interface AuditEntry {
    timestamp: string;
    action: string;
    ok: boolean;
    actor: 'web-console';
    target?: string;
    detail?: Record<string, unknown>;
  }

  function auditLogPath(): string {
    return join(getLogDir(), 'web-console-audit.log');
  }

  function scrubAuditDetail(value: unknown, depth = 0): unknown {
    if (depth > 3) return '[truncated]';
    if (value == null) return value;
    if (typeof value === 'string') {
      return value.length > 300 ? `${value.slice(0, 300)}...` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubAuditDetail(item, depth + 1));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (/token|secret|password|authorization|credential/i.test(key)) {
          out[key] = '[redacted]';
        } else {
          out[key] = scrubAuditDetail(item, depth + 1);
        }
      }
      return out;
    }
    return String(value);
  }

  function writeAuditEntry(action: string, ok: boolean, detail?: Record<string, unknown>): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action,
      ok,
      actor: 'web-console',
      target: typeof detail?.target === 'string' ? detail.target : undefined,
      detail: scrubAuditDetail(detail ?? {}) as Record<string, unknown>,
    };
    const path = auditLogPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch (err) {
      console.warn('[console] failed to write audit log:', err);
    }
  }

  function readAuditEntries(limit: number): AuditEntry[] {
    const path = auditLogPath();
    const raw = readLogTail(path, 512 * 1024);
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed audit rows.
      }
    }
    return entries.reverse().slice(0, Math.max(1, Math.min(limit, 300)));
  }

  // 处理客户端命令
  async function handleCommand(
    command: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      let result: { ok: boolean; message: string };
      switch (command) {
        case 'flush': {
          const success = await director.flush();
          result = {
            ok: success,
            message: success ? 'Flush 完成' : 'Flush 未能完成（超时或正在进行中）',
          };
          writeAuditEntry('director.flush', result.ok, { command, target: 'main', message: result.message });
          return result;
        }
        case 'clear': {
          const success = await director.clearContext();
          result = {
            ok: success,
            message: success ? 'Clear 完成，上下文已清空' : 'Clear 未能完成（正在进行中）',
          };
          writeAuditEntry('director.clear', result.ok, { command, target: 'main', message: result.message });
          return result;
        }
        case 'esc': {
          const cancelled = queue.cancelOldest();
          if (cancelled) {
            await director.interrupt();
            result = { ok: true, message: `已取消: "${cancelled.text.slice(0, 30)}..."` };
            writeAuditEntry('director.esc', true, { command, target: 'main', messageId: cancelled.messageId });
            return result;
          }
          result = { ok: false, message: '队列为空，没有可取消的消息' };
          writeAuditEntry('director.esc', false, { command, target: 'main', reason: 'empty queue' });
          return result;
        }
        case 'session-restart': {
          await director.restartProcess();
          result = { ok: true, message: 'Director 已重启' };
          writeAuditEntry('director.restart', true, { command, target: 'main' });
          return result;
        }
        default:
          result = { ok: false, message: `未知命令: ${command}` };
          writeAuditEntry('director.command_unknown', false, { command });
          return result;
      }
    } catch (err) {
      writeAuditEntry('director.command_error', false, { command, error: String(err) });
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

  // Chunk / stream-abort broadcast for streaming UI
  function broadcastWs(payload: string) {
    for (const ws of clients) {
      try { ws.send(payload); } catch { clients.delete(ws); }
    }
  }

  function sessionIdForDirector(label: string): string | null {
    if (label === director.label || label === 'main') return director.getStatus().sessionId;
    const entry = pool?.getPoolStatus().find((item) => item.label === label);
    if (!entry) return null;
    return pool?.get(entry.routingKey)?.bridge.getStatus().sessionId ?? entry.directorStatus?.sessionId ?? null;
  }

  director.on('chunk', (text: string) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chunk', director: director.label, sessionId: sessionIdForDirector(director.label), text }));
  });
  director.on('turn-event', (event: AssistantTurnEvent) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'turn_event', event }));
  });
  director.on('tool-call', (toolName?: string, tool?: DirectorToolCall) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'tool-call', director: director.label, sessionId: sessionIdForDirector(director.label), toolName, tool }));
  });
  director.on('stream-abort', () => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'stream-abort', director: director.label, sessionId: sessionIdForDirector(director.label) }));
  });
  director.on('input-message', (text: string) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chat_input', director: director.label, sessionId: sessionIdForDirector(director.label), text, timestamp: new Date().toISOString() }));
  });
  director.on('system-chunk', (text: string) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chunk', director: director.label, sessionId: sessionIdForDirector(director.label), text }));
  });
  director.on('system-response', (text: string, messageId: string) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chat_reply', director: director.label, sessionId: sessionIdForDirector(director.label), messageId, text }));
  });
  director.on('response', (text: string) => {
    if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chat_reply', director: director.label, sessionId: sessionIdForDirector(director.label), messageId: null, text }));
  });
  director.on('web-alert', (message: string) => {
    if (clients.size === 0) return;
    const taskCallback = message.startsWith('✅ 后台任务') || message.startsWith('❌ 后台任务');
    broadcastWs(JSON.stringify({
      type: taskCallback ? 'task_callback' : 'chat_reply',
      director: director.label,
      sessionId: sessionIdForDirector(director.label),
      messageId: null,
      text: taskCallback ? message : '⚠️ ' + message,
    }));
  });

  if (pool) {
    pool.on('chunk', (label: string, text: string) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chunk', director: label, sessionId: sessionIdForDirector(label), text }));
    });
    pool.on('turn-event', (_label: string, event: AssistantTurnEvent) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'turn_event', event }));
    });
    pool.on('tool-call', (label: string, toolName?: string, tool?: DirectorToolCall) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'tool-call', director: label, sessionId: sessionIdForDirector(label), toolName, tool }));
    });
    pool.on('stream-abort', (label: string) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'stream-abort', director: label, sessionId: sessionIdForDirector(label) }));
    });
    pool.on('input-message', (label: string, text: string) => {
      if (clients.size > 0) broadcastWs(JSON.stringify({ type: 'chat_input', director: label, sessionId: sessionIdForDirector(label), text, timestamp: new Date().toISOString() }));
    });
    // Web session reply/alert routing
    pool.on('web-reply', (label: string, messageId: string, text: string) => {
      broadcastWs(JSON.stringify({ type: 'chat_reply', director: label, sessionId: sessionIdForDirector(label), messageId, text }));
    });
    pool.on('web-alert', (label: string, message: string) => {
      const taskCallback = message.startsWith('✅ 后台任务') || message.startsWith('❌ 后台任务');
      broadcastWs(JSON.stringify({
        type: taskCallback ? 'task_callback' : 'chat_reply',
        director: label,
        sessionId: sessionIdForDirector(label),
        messageId: null,
        text: taskCallback ? message : '⚠️ ' + message,
      }));
    });
  }

  function runCreatedTask(task: ReturnType<typeof createTask>): void {
    if (!taskRunner) return;
    const extra = (task.extra ?? {}) as Record<string, unknown>;
    const parentMeta = taskParentMetadata(task.source_director ?? 'main');
    if (Object.keys(parentMeta).length > 0) {
      updateTask(task.id, { extra: { ...extra, ...parentMeta } });
    }
    taskRunner.runTask({
      taskId: task.id,
      role: task.role,
      agent: task.agent ?? undefined,
      model: extra.model as string | undefined,
      prompt: task.prompt,
      description: task.description,
      projectDir: extra.project_dir as string | undefined,
      timeoutMs: task.timeout_ms ?? undefined,
    });
  }

  function taskParentMetadata(sourceDirector: string): Record<string, unknown> {
    const source = sourceDirector || 'main';
    const ds = source === 'main' || !pool ? director.getStatus() : pool.findByLabel(source)?.bridge.getStatus();
    const poolEntry = source === 'main' || !pool ? undefined : pool.findByLabel(source);
    if (!ds) {
      return {
        parent_director_label: source,
        parent_director_status: 'not-found',
      };
    }
    const meta: Record<string, unknown> = {
      parent_director_label: source,
      parent_director_status: ds.alive ? 'alive' : 'offline',
      parent_session_id: ds.sessionId,
      parent_session_name: ds.sessionName,
      parent_agent: ds.agentName,
      parent_agent_type: ds.agentType,
      parent_persona_role: ds.personaRole,
      parent_pid: ds.pid,
    };
    if (ds.agentType === 'codex' || ds.agentType === 'codex-app-server') {
      meta.parent_codex_thread_id = ds.sessionId;
    }
    if (poolEntry) {
      meta.parent_group_name = poolEntry.groupName;
      meta.parent_routing_key = poolEntry.routingKey;
    }
    return meta;
  }

  async function runCronJobNow(job: CronJob): Promise<Record<string, unknown>> {
    const actionType = job.action_type ?? 'spawn_role';

    if (actionType === 'spawn_role') {
      if (!taskRunner) {
        throw new Error('Task runner is not available');
      }
      const active = [
        ...listTasks({ status: 'running', limit: 200 }),
        ...listTasks({ status: 'dispatched', limit: 200 }),
      ].some((task) => task.type === 'cron' && (task.extra as Record<string, unknown> | null)?.cronJobId === job.id);
      if (active) {
        const err = new Error('previous cron run is still active') as Error & { status?: number };
        err.status = 409;
        throw err;
      }
      const task = createTask({
        type: 'cron',
        role: job.role,
        agent: job.agent ?? undefined,
        description: job.description,
        prompt: job.prompt,
        max_retry: job.max_retry,
        timeout_ms: job.timeout_ms ?? undefined,
        source_director: job.source_director ?? undefined,
        extra: { cronJobId: job.id, manualRun: true },
      });
      runCreatedTask(task);
      updateCronJob(job.id, { last_run_at: localNow() });
      return { ok: true, action_type: actionType, taskId: task.id, task };
    }

    if (actionType === 'director_msg') {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const yesterday = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const msg = resolveCronMessage(config.director.persona_dir, job.message ?? '', { today, yesterday });
      const source = job.source_director;
      if (source && source !== 'main' && pool) {
        const entry = pool.findByLabel(source);
        if (entry) {
          await entry.bridge.sendCronMessage(msg);
          updateCronJob(job.id, { last_run_at: localNow() });
          return { ok: true, action_type: actionType, director: source };
        }
      }
      await director.sendCronMessage(msg);
      updateCronJob(job.id, { last_run_at: localNow() });
      return { ok: true, action_type: actionType, director: 'main' };
    }

    if (actionType === 'shell_action') {
      const actionName = job.action_name ?? '';
      if (isBashAction(actionName)) {
        const result = await runBashAction(extractBashCommand(actionName), { timeoutMs: job.timeout_ms ?? undefined });
        updateCronJob(job.id, { last_run_at: localNow() });
        return {
          ok: true,
          action_type: actionType,
          action_name: actionName,
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 2000),
        };
      }

      switch (actionName) {
        case 'check_feishu':
        case 'check_flush':
          updateCronJob(job.id, { last_run_at: localNow() });
          return { ok: true, action_type: actionType, action_name: actionName, message: 'reserved action acknowledged' };
        case 'flush':
          if (pool) await pool.flushAll();
          await director.flush();
          updateCronJob(job.id, { last_run_at: localNow() });
          return { ok: true, action_type: actionType, action_name: actionName };
        default:
          throw new Error(`unknown shell action: ${actionName || '(empty)'}`);
      }
    }

    throw new Error(`unsupported cron action: ${actionType}`);
  }

  async function switchDirectorAgent(label: string, agentName: string): Promise<Record<string, unknown>> {
    const targetLabel = label.trim() || 'main';
    if (!agentName.trim()) throw new Error('agent is required');
    if (targetLabel === 'main') {
      const ok = await director.switchAgent(agentName.trim());
      if (!ok) throw new Error(`failed to switch main Director to ${agentName}`);
      return {
        ok: true,
        director_label: 'main',
        agent: director.getDirectorAgentName(),
        agent_type: director.getDirectorAgentType(),
      };
    }
    if (!pool) {
      const err = new Error('Director pool is not available') as Error & { status?: number };
      err.status = 503;
      throw err;
    }
    const entry = await pool.switchAgentByLabel(targetLabel, agentName.trim());
    return {
      ok: true,
      director_label: entry.bridge.label,
      agent: entry.bridge.getDirectorAgentName(),
      agent_type: entry.bridge.getDirectorAgentType(),
    };
  }

  async function switchDirectorPersona(label: string, roleName: string): Promise<Record<string, unknown>> {
    const targetLabel = label.trim() || 'main';
    const role = roleName.trim().toLowerCase();
    if (!role) throw new Error('role is required');
    const availableRoles = listPersonaRoles(config.director.persona_dir).map((item) => item.role);
    if (!availableRoles.includes(role)) {
      const err = new Error(`unknown persona role: ${role}`) as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    if (targetLabel === 'main') {
      const ok = await director.switchPersona(role);
      if (!ok) throw new Error(`failed to switch main Director persona to ${role}`);
      return { ok: true, director_label: 'main', role: director.getPersonaRole() };
    }
    if (!pool) {
      const err = new Error('Director pool is not available') as Error & { status?: number };
      err.status = 503;
      throw err;
    }
    const entry = await pool.switchPersonaByLabel(targetLabel, role);
    return { ok: true, director_label: entry.bridge.label, role: entry.bridge.getPersonaRole() };
  }

  type RuntimeDirectorCommand = 'flush' | 'clear' | 'esc' | 'session-restart' | 'detach';

  function normalizeRuntimeDirectorCommand(command: string): RuntimeDirectorCommand {
    const normalized = command.trim() === 'restart' ? 'session-restart' : command.trim();
    if (['flush', 'clear', 'esc', 'session-restart', 'detach'].includes(normalized)) {
      return normalized as RuntimeDirectorCommand;
    }
    const err = new Error(`unknown Director command: ${command || '(empty)'}`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  function runtimeDirectorAuditAction(command: RuntimeDirectorCommand): string {
    if (command === 'session-restart') return 'director.restart';
    if (command === 'esc') return 'director.esc';
    return `director.${command}`;
  }

  async function runRuntimeDirectorCommand(label: string, command: string): Promise<Record<string, unknown>> {
    const targetLabel = label.trim() || 'main';
    const normalized = normalizeRuntimeDirectorCommand(command);
    if (targetLabel === 'main') {
      if (normalized === 'detach') {
        const err = new Error('main Director detach is not supported from web console') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const result = await handleCommand(normalized);
      return { ...result, director_label: 'main', command: normalized };
    }
    if (!pool) {
      const err = new Error('Director pool is not available') as Error & { status?: number };
      err.status = 503;
      throw err;
    }

    let result: { ok: boolean; message: string; detail?: Record<string, unknown> };
    try {
      switch (normalized) {
        case 'flush': {
          const success = await pool.flushByLabel(targetLabel);
          result = {
            ok: success,
            message: success ? 'Flush 完成' : 'Flush 未能完成（超时或正在进行中）',
          };
          break;
        }
        case 'clear': {
          const success = await pool.clearContextByLabel(targetLabel);
          result = {
            ok: success,
            message: success ? 'Clear 完成，上下文已清空' : 'Clear 未能完成（正在进行中）',
          };
          break;
        }
        case 'esc': {
          const cancelled = await pool.interruptOldestByLabel(targetLabel);
          result = cancelled
            ? {
              ok: true,
              message: `已取消: "${cancelled.text.slice(0, 30)}..."`,
              detail: { messageId: cancelled.messageId, correlationId: cancelled.correlationId },
            }
            : { ok: false, message: '队列为空，没有可取消的消息' };
          break;
        }
        case 'session-restart':
          await pool.restartByLabel(targetLabel);
          result = { ok: true, message: 'Director 已重启' };
          break;
        case 'detach': {
          const entry = await pool.detachByLabel(targetLabel);
          result = {
            ok: true,
            message: 'Director 已 Detach，底层进程未主动关闭',
            detail: { routingKey: entry.routingKey, groupName: entry.groupName },
          };
          break;
        }
      }
    } catch (err) {
      if ((err as Error).message.startsWith('Director label not found:')) {
        const notFound = new Error((err as Error).message) as Error & { status?: number };
        notFound.status = 404;
        throw notFound;
      }
      throw err;
    }

    writeAuditEntry(runtimeDirectorAuditAction(normalized), result.ok, {
      command: normalized,
      target: targetLabel,
      message: result.message,
      ...(result.detail ?? {}),
    });
    return { ok: result.ok, director_label: targetLabel, command: normalized, message: result.message, ...(result.detail ?? {}) };
  }

  function stateFilePath(kind: 'state' | 'todo'): string {
    const personaDir = config.director.persona_dir;
    return kind === 'state'
      ? join(personaDir, 'daily', 'state.md')
      : join(personaDir, 'TODO.md');
  }

  type PersonaDocCategory = 'core' | 'roles' | 'prompts' | 'memory' | 'daily' | 'workspace' | 'session' | 'skills' | 'config';

  interface PersonaDocEntry {
    category: PersonaDocCategory;
    path: string;
    name: string;
    size: number;
    mtimeMs: number;
    editable: boolean;
  }

  function personaDocCategory(relativePath: string): PersonaDocCategory {
    if (relativePath.startsWith('personas/')) return 'roles';
    if (relativePath.startsWith('prompts/')) return 'prompts';
    if (relativePath.startsWith('memory/')) return 'memory';
    if (relativePath.startsWith('daily/')) return 'daily';
    if (relativePath.startsWith('workspaces/')) return 'workspace';
    if (relativePath.startsWith('state/sessions/')) return 'session';
    if (relativePath.startsWith('skills/')) return 'skills';
    if (/\.(json|ya?ml)$/i.test(relativePath)) return 'config';
    return 'core';
  }

  function normalizePersonaDocPath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const safe = normalize(normalized);
    if (!safe || safe.startsWith('..') || safe.startsWith('/')) {
      throw new Error(`unsafe persona doc path: ${relativePath}`);
    }
    return safe.replace(/\\/g, '/');
  }

  function resolvePersonaDocPath(relativePath: string): string {
    const safe = normalizePersonaDocPath(relativePath);
    const root = resolve(config.director.persona_dir);
    const filePath = resolve(root, safe);
    if (filePath !== root && !filePath.startsWith(root + '/')) {
      throw new Error(`persona doc path escapes persona dir: ${relativePath}`);
    }
    return filePath;
  }

  function isPersonaDocEditable(relativePath: string): boolean {
    return /\.(md|markdown)$/i.test(relativePath);
  }

  function isPersonaDocFile(name: string): boolean {
    return /\.(md|markdown|json|ya?ml)$/i.test(name);
  }

  function isAllowedPersonaDocPath(path: string): boolean {
    const root = resolve(config.director.persona_dir);
    const target = resolve(path);
    if (!isInside(root, target)) return false;
    if (!existsSync(target)) return false;
    const stat = statSync(target);
    if (!stat.isFile()) return false;
    const rel = relative(root, target).replace(/\\/g, '/');
    return isPersonaDocFile(rel);
  }

  function isAllowedLogPath(path: string): boolean {
    const target = resolve(path);
    if (target === resolve(auditLogPath())) return true;
    return collectLogSources().some((source) => resolve(source.path) === target);
  }

  function isAllowedRevealPath(path: string): boolean {
    const target = resolve(path);
    if (!existsSync(target)) return false;
    const stat = statSync(target);
    if (!stat.isFile()) return false;
    return isAllowedWorkbenchFile(target) || isAllowedPersonaDocPath(target) || isAllowedLogPath(target);
  }

  function revealLocalPath(path: string): Promise<void> {
    const target = resolve(path);
    return new Promise((resolveReveal, reject) => {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const args = process.platform === 'win32'
        ? [`/select,${target}`]
        : process.platform === 'darwin'
          ? ['-R', target]
          : [dirname(target)];
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolveReveal();
      });
    });
  }

  function personaDocEntry(root: string, filePath: string): PersonaDocEntry | null {
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;
    const rel = relative(root, filePath).replace(/\\/g, '/');
    if (!isPersonaDocFile(rel)) return null;
    return {
      category: personaDocCategory(rel),
      path: rel,
      name: rel.split('/').slice(-1)[0],
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      editable: isPersonaDocEditable(rel),
    };
  }

  function listPersonaDocs(): PersonaDocEntry[] {
    const root = resolve(config.director.persona_dir);
    const docs: PersonaDocEntry[] = [];
    const seen = new Set<string>();

    function addFile(filePath: string): void {
      try {
        if (!existsSync(filePath)) return;
        const entry = personaDocEntry(root, filePath);
        if (!entry || seen.has(entry.path)) return;
        seen.add(entry.path);
        docs.push(entry);
      } catch {
        // Ignore unreadable persona docs.
      }
    }

    function visit(dir: string, remainingDepth: number): void {
      if (remainingDepth < 0 || !existsSync(dir)) return;
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path, remainingDepth - 1);
        else if (entry.isFile()) addFile(path);
      }
    }

    for (const file of ['soul.md', 'meta.md', 'TODO.md', 'CLAUDE.md', 'config.yaml', 'config.yml', 'config.json']) {
      addFile(join(root, file));
    }
    for (const dir of ['personas', 'prompts', 'memory', 'daily', 'workspaces', 'state/sessions', 'skills']) {
      visit(join(root, dir), dir === 'workspaces' || dir === 'skills' ? 4 : 2);
    }

    return docs.sort((a, b) => {
      const categoryOrder: PersonaDocCategory[] = ['core', 'roles', 'prompts', 'memory', 'daily', 'workspace', 'session', 'skills', 'config'];
      const ca = categoryOrder.indexOf(a.category);
      const cb = categoryOrder.indexOf(b.category);
      if (ca !== cb) return ca - cb;
      return a.path.localeCompare(b.path);
    }).slice(0, 500);
  }

  function expandUserPath(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return path;
  }

  function redactConfigText(text: string): string {
    return text
      .split('\n')
      .map((line) => {
        if (/^\s*#/.test(line)) return line;
        return line.replace(/^(\s*["']?[^"':=]*(?:secret|token|password|authorization|credential|api[_-]?key)[^"':=]*["']?\s*[:=]\s*)(.*)$/i, '$1[redacted]');
      })
      .join('\n');
  }

  function readRedactedPreview(path: string, maxBytes = 64 * 1024): { exists: boolean; content: string; size: number; mtimeMs: number | null; truncated: boolean } {
    if (!existsSync(path)) return { exists: false, content: '', size: 0, mtimeMs: null, truncated: false };
    const stat = statSync(path);
    if (!stat.isFile()) return { exists: false, content: '', size: 0, mtimeMs: null, truncated: false };
    const raw = readFileSync(path, 'utf-8');
    return {
      exists: true,
      content: redactConfigText(raw.slice(0, maxBytes)),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      truncated: Buffer.byteLength(raw, 'utf-8') > maxBytes,
    };
  }

  function collectConfigFiles() {
    const files = new Map<string, { label: string; path: string }>();
    const mainConfig = defaultConfigPath();
    files.set(mainConfig, { label: 'config.yaml', path: mainConfig });
    const personaConfig = join(config.director.persona_dir, 'config.yaml');
    files.set(personaConfig, { label: 'persona/config.yaml', path: personaConfig });
    const mcpPath = join(config.director.persona_dir, '.mcp.json');
    files.set(mcpPath, { label: 'persona/.mcp.json', path: mcpPath });
    for (const [name, provider] of Object.entries(config.agents.providers)) {
      if (provider.mcp_config_file) {
        const path = resolve(expandUserPath(provider.mcp_config_file));
        files.set(path, { label: `provider:${name} mcp`, path });
      }
      if (provider.agent_file) {
        const path = resolve(config.director.persona_dir, provider.agent_file);
        files.set(path, { label: `provider:${name} agent`, path });
      }
    }
    return [...files.values()].map((file) => ({ ...file, ...readRedactedPreview(file.path) }));
  }

  function safeJsonConfig(value: unknown): unknown {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(safeJsonConfig);
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (/secret|token|password|authorization|credential|api[_-]?key/i.test(key)) {
          out[key] = '[redacted]';
        } else {
          out[key] = safeJsonConfig(item);
        }
      }
      return out;
    }
    return value;
  }

  function collectMcpConfigs() {
    const configs = collectConfigFiles().filter((file) => file.path.endsWith('.json') && /mcp/i.test(file.label + file.path));
    return configs.map((file) => {
      let servers: Array<{ name: string; command: string | null; args: string[]; envKeys: string[]; disabled: boolean }> = [];
      let parseError: string | null = null;
      let preview = file.content;
      if (file.exists) {
        try {
          const parsed = JSON.parse(readFileSync(file.path, 'utf-8')) as { mcpServers?: Record<string, Record<string, unknown>> };
          const mcpServers = parsed.mcpServers ?? {};
          servers = Object.entries(mcpServers).map(([name, server]) => ({
            name,
            command: typeof server.command === 'string' ? server.command : null,
            args: Array.isArray(server.args) ? server.args.map(String) : [],
            envKeys: server.env && typeof server.env === 'object' ? Object.keys(server.env as Record<string, unknown>).sort() : [],
            disabled: Boolean(server.disabled),
          }));
          preview = JSON.stringify(safeJsonConfig(parsed), null, 2);
        } catch (err) {
          parseError = String(err);
        }
      }
      return {
        label: file.label,
        path: file.path,
        exists: file.exists,
        size: file.size,
        mtimeMs: file.mtimeMs,
        servers,
        parseError,
        preview,
      };
    });
  }

  function skillSummaryFromFile(path: string): { name: string; description: string } {
    const raw = readFileSync(path, 'utf-8').slice(0, 4096);
    const name = raw.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]
      ?? raw.match(/^#\s+(.+)$/m)?.[1]
      ?? path.split('/').slice(-2, -1)[0]
      ?? 'skill';
    const description = raw.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]
      ?? raw.split('\n').find((line) => line.trim() && !line.startsWith('---') && !/^name:|^description:/i.test(line))?.trim()
      ?? '';
    return { name, description };
  }

  function collectSkills() {
    const roots = new Map<string, string>();
    roots.set('persona', join(config.director.persona_dir, 'skills'));
    for (const [name, provider] of Object.entries(config.agents.providers)) {
      if (provider.skills_dir) roots.set(`provider:${name}`, resolve(expandUserPath(provider.skills_dir)));
    }
    const skills: Array<{ source: string; name: string; description: string; path: string; mtimeMs: number; size: number }> = [];

    function visit(source: string, dir: string, depth: number): void {
      if (depth < 0 || !existsSync(dir)) return;
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const skillFile = join(dir, 'SKILL.md');
      if (existsSync(skillFile)) {
        try {
          const stat = statSync(skillFile);
          const summary = skillSummaryFromFile(skillFile);
          skills.push({ source, name: summary.name, description: summary.description, path: skillFile, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch {
          // Ignore unreadable skill files.
        }
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) visit(source, join(dir, entry.name), depth - 1);
      }
    }

    for (const [source, root] of roots) visit(source, root, 4);
    return skills.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)).slice(0, 300);
  }

  function buildConfigAssets() {
    return {
      configFiles: collectConfigFiles(),
      mcpConfigs: collectMcpConfigs(),
      skills: collectSkills(),
    };
  }

  let webClientRef: MessagingClient | null = null;

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    async fetch(req, server) {
      const url = new URL(req.url);

      // Skip auth for static assets and HTML pages
      const isStaticAsset = url.pathname === '/' ||
        url.pathname.startsWith('/css/') ||
        url.pathname.startsWith('/js/') ||
        url.pathname === '/v2' ||
        url.pathname.startsWith('/v2/');
      if (!isStaticAsset) {
        // Token 认证检查
        const authErr = checkAuth(req);
        if (authErr) return authErr;
      }

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
          // Serve web-v2 SPA under /v2
          if (url.pathname === '/v2' || url.pathname.startsWith('/v2/')) {
            const subPath = url.pathname === '/v2' ? '' : url.pathname.slice(3);
            if (subPath === '' || subPath === '/') {
              try {
                const html = readFileSync(v2HtmlPath, 'utf-8');
                return new Response(html, {
                  headers: { 'Content-Type': 'text/html; charset=utf-8' },
                });
              } catch {
                return new Response('web-v2 not built. Run: cd web-v2 && bun run build', { status: 404 });
              }
            }
            const filePath = resolve(v2Dir, subPath.slice(1));
            if (!filePath.startsWith(v2Dir + '/')) {
              return new Response('Forbidden', { status: 403 });
            }
            if (existsSync(filePath) && statSync(filePath).isFile()) {
              const ext = extname(filePath).toLowerCase();
              const mimeTypes: Record<string, string> = {
                '.css': 'text/css; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.html': 'text/html; charset=utf-8',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.ico': 'image/x-icon',
                '.json': 'application/json',
                '.woff': 'font/woff',
                '.woff2': 'font/woff2',
              };
              const file = Bun.file(filePath);
              return new Response(file, {
                headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' },
              });
            }
            // SPA fallback: unknown paths serve index.html for client-side routing
            try {
              const html = readFileSync(v2HtmlPath, 'utf-8');
              return new Response(html, {
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
              });
            } catch {
              return new Response('Not found', { status: 404 });
            }
          }

          // Serve static files from /css/ and /js/ subdirectories
          if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
            const filePath = resolve(publicDir, url.pathname.slice(1));
            // Prevent path traversal — resolved path must stay inside publicDir
            if (!filePath.startsWith(publicDir + '/')) {
              return new Response('Forbidden', { status: 403 });
            }
            if (existsSync(filePath) && statSync(filePath).isFile()) {
              const ext = extname(filePath).toLowerCase();
              const mimeTypes: Record<string, string> = {
                '.css': 'text/css; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
              };
              const content = readFileSync(filePath, 'utf-8');
              return new Response(content, {
                headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' },
              });
            }
          }

          // GET /api/state — read state.md and TODO.md for dashboard
          if (url.pathname === '/api/state' && req.method === 'GET') {
            let state = '';
            let todo = '';
            try { state = readFileSync(stateFilePath('state'), 'utf-8'); } catch { /* ok */ }
            try { todo = readFileSync(stateFilePath('todo'), 'utf-8'); } catch { /* ok */ }
            return Response.json({ state, todo });
          }
          if (url.pathname === '/api/state' && req.method === 'PUT') {
            const body = await req.json() as { kind?: string; content?: string };
            const kind = body.kind === 'todo' ? 'todo' : body.kind === 'state' ? 'state' : null;
            if (!kind) {
              writeAuditEntry('state.update', false, { target: body.kind ?? null, error: 'kind must be state or todo' });
              return Response.json({ ok: false, error: 'kind must be state or todo' }, { status: 400 });
            }
            if (typeof body.content !== 'string') {
              writeAuditEntry('state.update', false, { target: kind, error: 'content must be a string' });
              return Response.json({ ok: false, error: 'content must be a string' }, { status: 400 });
            }
            if (body.content.length > 512 * 1024) {
              writeAuditEntry('state.update', false, { target: kind, error: 'content is too large', bytes: Buffer.byteLength(body.content, 'utf-8') });
              return Response.json({ ok: false, error: 'content is too large' }, { status: 413 });
            }
            const filePath = stateFilePath(kind);
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, body.content, 'utf-8');
            writeAuditEntry('state.update', true, { target: kind, path: filePath, bytes: Buffer.byteLength(body.content, 'utf-8') });
            return Response.json({ ok: true, kind, path: filePath });
          }

          // GET /api/config-summary — safe, redacted runtime configuration for Settings
          if (url.pathname === '/api/config-summary' && req.method === 'GET') {
            return Response.json(buildConfigSummary());
          }

          // GET /api/env-check — check whether local runtime commands are available
          if (url.pathname === '/api/env-check' && req.method === 'GET') {
            return Response.json({ checks: await runEnvChecks() });
          }

          // GET /api/debug-bundle — export a redacted local troubleshooting bundle
          if (url.pathname === '/api/debug-bundle' && req.method === 'GET') {
            return Response.json(await buildDebugBundle());
          }

          // GET /api/observability/diagnostics — aggregate task/log health signals
          if (url.pathname === '/api/observability/diagnostics' && req.method === 'GET') {
            return Response.json(buildObservabilityDiagnostics());
          }

          // POST /api/debug/simulate-message — inject a local IncomingMessage through the normal message handlers
          if (url.pathname === '/api/debug/simulate-message' && req.method === 'POST') {
            const body = await req.json() as {
              text?: string;
              chat_type?: 'p2p' | 'group';
              chat_id?: string;
              group_name?: string;
              sender_name?: string;
              thread_id?: string;
              quoted_text?: string;
            };
            const text = (body.text ?? '').trim();
            if (!text) return Response.json({ ok: false, error: 'text is required' }, { status: 400 });
            if (text.length > 10_000) return Response.json({ ok: false, error: 'text is too long' }, { status: 413 });
            const chatType = body.chat_type === 'group' ? 'group' : 'p2p';
            const messageId = `debug-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const chatId = (body.chat_id || (chatType === 'group' ? 'debug-group' : 'debug-p2p')).trim();
            const incoming: IncomingMessage = {
              text,
              messageId,
              chatId,
              chatType,
              groupName: chatType === 'group' ? (body.group_name || 'Debug Group') : undefined,
              memberCount: chatType === 'group' ? 3 : undefined,
              threadId: body.thread_id?.trim() || undefined,
              quotedText: body.quoted_text?.trim() || undefined,
              senderOpenId: config.feishu.master_id || 'debug-user',
              senderName: body.sender_name?.trim() || 'Debug User',
            };
            for (const handler of chatHandlers) {
              await handler(incoming);
            }
            writeAuditEntry('debug.simulate_message', true, {
              target: chatId,
              messageId,
              chatType,
              groupName: incoming.groupName ?? null,
              textPreview: text.slice(0, 160),
            });
            return Response.json({ ok: true, message_id: messageId, chat_id: chatId, chat_type: chatType, handlers: chatHandlers.length });
          }

          // POST /api/debug/simulate-task-completion — notify a Director as if a task finished
          if (url.pathname === '/api/debug/simulate-task-completion' && req.method === 'POST') {
            const body = await req.json() as { task_id?: string; success?: boolean; director_label?: string; reply_to_message_id?: string };
            const taskId = (body.task_id ?? '').trim();
            if (!taskId) return Response.json({ ok: false, error: 'task_id is required' }, { status: 400 });
            const task = getTask(taskId);
            if (!task) return Response.json({ ok: false, error: `task not found: ${taskId}` }, { status: 404 });
            const success = body.success !== false;
            const directorLabel = (body.director_label || task.source_director || 'main').trim() || 'main';
            const replyToMessageId = body.reply_to_message_id?.trim() || undefined;
            if (directorLabel === 'main') {
              await director.notifyTaskDone(taskId, success, replyToMessageId);
            } else {
              if (!pool) return Response.json({ ok: false, error: 'Director pool is unavailable' }, { status: 503 });
              if (!pool.findByLabel(directorLabel)) return Response.json({ ok: false, error: `Director not found: ${directorLabel}` }, { status: 404 });
              await pool.notifyTaskDone(directorLabel, taskId, success, replyToMessageId);
            }
            writeAuditEntry('debug.simulate_task_completion', true, {
              target: taskId,
              success,
              directorLabel,
              replyToMessageId: replyToMessageId ?? null,
            });
            return Response.json({ ok: true, task_id: taskId, success, director_label: directorLabel });
          }

          // GET /api/audit-log — recent Web Console mutation operations
          if (url.pathname === '/api/audit-log' && req.method === 'GET') {
            const limit = Number(url.searchParams.get('limit') ?? 100);
            return Response.json({ entries: readAuditEntries(limit), path: auditLogPath() });
          }

          // GET /api/config-assets — read-only redacted config, MCP and skills inventory
          if (url.pathname === '/api/config-assets' && req.method === 'GET') {
            return Response.json(buildConfigAssets());
          }

          // GET /api/files — list safe persona artifacts for the Workbench Files view
          if (url.pathname === '/api/files' && req.method === 'GET') {
            const scope = url.searchParams.get('scope') ?? undefined;
            return Response.json({
              roots: {
                outbox: resolve(config.director.persona_dir, 'outbox'),
                attachments: resolve(config.director.persona_dir, 'attachments'),
                taskResults: 'recorded task.result_file entries',
              },
              safety: {
                preview: 'outbox, attachments, and recorded task result files',
                download: 'outbox, attachments, and recorded task result files',
                send: 'outbox, attachments, recorded task result files, and /tmp',
              },
              files: listWorkbenchFiles(scope),
            });
          }

          // GET /api/files/content?path=... — preview safe text/markdown files
          if (url.pathname === '/api/files/content' && req.method === 'GET') {
            const rawPath = url.searchParams.get('path');
            if (!rawPath) return Response.json({ error: 'path is required' }, { status: 400 });
            const path = resolve(rawPath);
            if (!isAllowedWorkbenchFile(path)) return Response.json({ error: `Path not allowed: ${path}` }, { status: 403 });
            if (!existsSync(path)) return Response.json({ error: `File not found: ${path}` }, { status: 404 });
            const stat = statSync(path);
            if (!stat.isFile()) return Response.json({ error: 'Not a file' }, { status: 400 });

            const kind = fileKind(path);
            const previewable = kind === 'markdown' || kind === 'text' || kind === 'image';
            if (!previewable) {
              return Response.json({ path, kind, size: stat.size, previewable: false });
            }
            if (kind === 'image') {
              const maxImageBytes = 8 * 1024 * 1024;
              if (stat.size > maxImageBytes) {
                return Response.json({ path, kind, size: stat.size, previewable: false, error: 'image is too large to preview' });
              }
              const bytes = readFileSync(path);
              return Response.json({
                path,
                kind,
                size: stat.size,
                previewable: true,
                mime: imageMimeType(path),
                dataUrl: `data:${imageMimeType(path)};base64,${bytes.toString('base64')}`,
              });
            }
            const maxPreviewBytes = 256 * 1024;
            const content = readFileSync(path, 'utf-8');
            return Response.json({
              path,
              kind,
              size: stat.size,
              previewable: true,
              truncated: Buffer.byteLength(content, 'utf-8') > maxPreviewBytes,
              content: content.slice(0, maxPreviewBytes),
            });
          }

          // GET /api/files/download?path=... — download a safe artifact file
          if (url.pathname === '/api/files/download' && req.method === 'GET') {
            const rawPath = url.searchParams.get('path');
            if (!rawPath) return Response.json({ error: 'path is required' }, { status: 400 });
            const path = resolve(rawPath);
            if (!isAllowedWorkbenchFile(path)) return Response.json({ error: `Path not allowed: ${path}` }, { status: 403 });
            if (!existsSync(path)) return Response.json({ error: `File not found: ${path}` }, { status: 404 });
            const stat = statSync(path);
            if (!stat.isFile()) return Response.json({ error: 'Not a file' }, { status: 400 });
            const bytes = readFileSync(path);
            writeAuditEntry('file.download', true, { target: path, bytes: stat.size });
            return new Response(bytes, {
              headers: {
                'Content-Type': downloadMimeType(path),
                'Content-Length': String(stat.size),
                'Content-Disposition': contentDispositionForPath(path),
                'Cache-Control': 'no-store',
              },
            });
          }

          // POST /api/open-path — reveal a safe local workbench/log/persona document path in Finder
          if (url.pathname === '/api/open-path' && req.method === 'POST') {
            const body = await req.json() as { path?: string; persona_doc?: string };
            const rawPersonaDoc = typeof body.persona_doc === 'string' ? body.persona_doc.trim() : '';
            const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
            if (!rawPersonaDoc && !rawPath) {
              writeAuditEntry('file.reveal', false, { target: null, personaDoc: null, error: 'path or persona_doc is required' });
              return Response.json({ ok: false, error: 'path or persona_doc is required' }, { status: 400 });
            }
            let path: string;
            try {
              path = rawPersonaDoc ? resolvePersonaDocPath(rawPersonaDoc) : resolve(rawPath);
            } catch (err) {
              writeAuditEntry('file.reveal', false, { target: rawPath || null, personaDoc: rawPersonaDoc || null, error: String(err) });
              return Response.json({ ok: false, error: String(err) }, { status: 400 });
            }
            if (!isAllowedRevealPath(path)) {
              writeAuditEntry('file.reveal', false, { target: path, personaDoc: rawPersonaDoc || null, error: 'Path not allowed' });
              return Response.json({ ok: false, error: `Path not allowed: ${path}` }, { status: 403 });
            }
            try {
              await revealLocalPath(path);
              writeAuditEntry('file.reveal', true, { target: path, personaDoc: rawPersonaDoc || null });
              return Response.json({ ok: true, path });
            } catch (err) {
              writeAuditEntry('file.reveal', false, { target: path, personaDoc: rawPersonaDoc || null, error: String(err) });
              return Response.json({ ok: false, error: String(err) }, { status: 500 });
            }
          }

          // GET /api/files/tree?root=... — list project directory tree (text files only)
          if (url.pathname === '/api/files/tree' && req.method === 'GET') {
            const rawRoot = url.searchParams.get('root');
            if (!rawRoot) return Response.json({ error: 'root is required' }, { status: 400 });
            const root = resolve(rawRoot);
            if (!existsSync(root) || !statSync(root).isDirectory()) {
              return Response.json({ error: 'Not a directory' }, { status: 404 });
            }
            const maxDepth = Math.min(Number(url.searchParams.get('depth') ?? 4), 6);
            const skipDirs = new Set([
              'node_modules', '.git', '.next', 'dist', 'build', '.turbo',
              '__pycache__', '.pytest_cache', '.mypy_cache', 'vendor',
              '.claude', '.persona', 'target', '.venv', 'venv',
            ]);
            const binaryExts = new Set([
              '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
              '.woff', '.woff2', '.ttf', '.eot', '.otf',
              '.zip', '.tar', '.gz', '.br', '.7z', '.rar',
              '.exe', '.dll', '.so', '.dylib', '.o', '.a',
              '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt',
              '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
              '.db', '.sqlite', '.sqlite3',
              '.wasm', '.pyc', '.class',
            ]);
            interface TreeEntry { name: string; path: string; type: 'file' | 'dir'; size?: number; children?: TreeEntry[] }
            function walk(dir: string, depth: number): TreeEntry[] {
              if (depth > maxDepth) return [];
              try {
                const entries = readdirSync(dir, { withFileTypes: true });
                const result: TreeEntry[] = [];
                for (const entry of entries) {
                  if (entry.name.startsWith('.') && depth > 0) continue;
                  const fullPath = join(dir, entry.name);
                  if (entry.isDirectory()) {
                    if (skipDirs.has(entry.name)) continue;
                    const children = walk(fullPath, depth + 1);
                    if (children.length > 0 || depth < 2) {
                      result.push({ name: entry.name, path: fullPath, type: 'dir', children });
                    }
                  } else if (entry.isFile()) {
                    const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : '';
                    if (binaryExts.has(ext)) continue;
                    try {
                      const s = statSync(fullPath);
                      if (s.size > 512 * 1024) continue;
                      result.push({ name: entry.name, path: fullPath, type: 'file', size: s.size });
                    } catch { continue; }
                  }
                }
                result.sort((a, b) => {
                  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                  return a.name.localeCompare(b.name);
                });
                return result;
              } catch { return []; }
            }
            return Response.json({ root, tree: walk(root, 0) });
          }

          // GET /api/files/read?path=... — read a text file from project directory
          if (url.pathname === '/api/files/read' && req.method === 'GET') {
            const rawPath = url.searchParams.get('path');
            if (!rawPath) return Response.json({ error: 'path is required' }, { status: 400 });
            const path = resolve(rawPath);
            if (!existsSync(path)) return Response.json({ error: 'Not found' }, { status: 404 });
            const stat = statSync(path);
            if (!stat.isFile()) return Response.json({ error: 'Not a file' }, { status: 400 });
            if (stat.size > 512 * 1024) return Response.json({ error: 'File too large (>512KB)' }, { status: 413 });
            try {
              const content = readFileSync(path, 'utf-8');
              return Response.json({ path, size: stat.size, content });
            } catch {
              return Response.json({ error: 'Cannot read file' }, { status: 500 });
            }
          }

          // POST /api/files/upload — store browser-selected files under persona attachments
          if (url.pathname === '/api/files/upload' && req.method === 'POST') {
            const form = await req.formData();
            const values = form.getAll('files');
            const uploadDir = resolve(config.director.persona_dir, 'attachments', 'web', attachmentUploadDay());
            const maxFiles = 10;
            const maxFileBytes = 32 * 1024 * 1024;
            const maxTotalBytes = 64 * 1024 * 1024;
            const uploaded: WorkbenchFile[] = [];
            let totalBytes = 0;

            mkdirSync(uploadDir, { recursive: true });
            for (const value of values) {
              if (!(value instanceof File)) continue;
              if (uploaded.length >= maxFiles) {
                return Response.json({ error: `too many files; max ${maxFiles}` }, { status: 413 });
              }
              if (value.size <= 0) {
                return Response.json({ error: `${value.name || 'file'} is empty` }, { status: 400 });
              }
              if (value.size > maxFileBytes) {
                return Response.json({ error: `${value.name || 'file'} is too large` }, { status: 413 });
              }
              totalBytes += value.size;
              if (totalBytes > maxTotalBytes) {
                return Response.json({ error: 'upload batch is too large' }, { status: 413 });
              }

              const safeName = safeAttachmentFileName(value.name || 'attachment');
              const target = resolve(uploadDir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
              if (!isInside(uploadDir, target)) {
                return Response.json({ error: `unsafe filename: ${value.name}` }, { status: 400 });
              }
              const bytes = Buffer.from(await value.arrayBuffer());
              writeFileSync(target, bytes);
              uploaded.push(workbenchAttachmentFile(target));
            }

            if (uploaded.length === 0) {
              return Response.json({ error: 'files are required' }, { status: 400 });
            }
            writeAuditEntry('file.upload', true, {
              target: uploadDir,
              files: uploaded.map((file) => file.path),
              bytes: totalBytes,
            });
            return Response.json({ ok: true, files: uploaded });
          }

          // GET /api/logs/sources — list safe log files under persona logs directory
          if (url.pathname === '/api/logs/sources' && req.method === 'GET') {
            return Response.json({ sources: collectLogSources() });
          }

          // GET /api/search?q=... — search recent sessions, tasks, and safe log tails
          if (url.pathname === '/api/search' && req.method === 'GET') {
            const query = url.searchParams.get('q') ?? '';
            const limit = Number(url.searchParams.get('limit') ?? 40);
            return Response.json(buildGlobalSearch(query, limit));
          }

          // GET /api/logs/tail?id=...&bytes=N — tail a safe log file under persona logs directory
          if (url.pathname === '/api/logs/tail' && req.method === 'GET') {
            const id = url.searchParams.get('id');
            if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
            const path = resolveLogSource(id);
            if (!path) return Response.json({ error: `Log source not found: ${id}` }, { status: 404 });
            const stat = statSync(path);
            const requestedBytes = Number(url.searchParams.get('bytes') ?? 128 * 1024);
            const maxBytes = Math.max(4 * 1024, Math.min(Number.isFinite(requestedBytes) ? requestedBytes : 128 * 1024, 512 * 1024));
            return Response.json({
              id,
              path,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              content: readLogTail(path, maxBytes),
            });
          }

          // POST /api/send — send arbitrary text to Director (bypass messaging)
          if (url.pathname === '/api/send' && req.method === 'POST') {
            const body = await req.json() as { text: string; director?: string; workspace?: string };
            if (!body.text) return Response.json({ ok: false, message: 'text is required' }, { status: 400 });

            // Intercept /shell-restart commands
            const trimmed = body.text.trim();
            if (trimmed === '/shell-restart' || trimmed === '/restart-shell' ||
                trimmed === '/shell-restart --force' || trimmed === '/restart-shell --force') {
              const isForce = trimmed.includes('--force');
              const runningTasks = taskRunner?.getRunningTasks() ?? [];
              if (runningTasks.length > 0 && !isForce) {
                const listed = runningTasks.slice(0, 5).join(', ');
                const overflow = runningTasks.length > 5 ? ` ...+${runningTasks.length - 5}` : '';
                return Response.json({
                  ok: false,
                  message: `Shell 重启已拒绝：当前有 ${runningTasks.length} 个后台任务仍在运行：${listed}${overflow}。请使用 /shell-restart --force 强制重启。`,
                });
              }
              broadcastWs(JSON.stringify({ type: 'chat_reply', director: 'main', messageId: null, text: isForce ? 'Shell 正在强制重启...' : 'Shell 正在重启...' }));
              writeAuditEntry('shell.restart', true, { source: 'web', force: isForce });
              if (pool) await pool.detachAll();
              await director.shutdown();
              setTimeout(() => process.exit(0), 500);
              return Response.json({ ok: true, message: 'restarting' });
            }

            try {
              // Resolve target workspace: prefer director (compat), fallback workspace
              const targetName = (body.director && body.director !== 'main')
                ? body.director
                : (body.workspace && body.workspace !== 'main')
                  ? body.workspace
                  : undefined;

              if (targetName && pool) {
                let entry = pool.resolveWorkspace(targetName);

                // Auto-create pool Director for web workspace
                if (!entry && body.workspace) {
                  const wsName = sanitizeWorkspaceName(body.workspace);
                  if (wsName) {
                    const routingKey = `web-workspace:${wsName}`;
                    const wsConfig = getWorkspaceConfig(wsName);
                    entry = await pool.getOrCreate(routingKey, {
                      groupName: wsName,
                      feishuChatId: 'web-console',
                      directorAgentName: wsConfig?.agent,
                    });
                    broadcastWs(JSON.stringify({ type: 'context_update', workspace: wsName, label: entry.bridge.label }));
                    writeAuditEntry('workspace.director.create', true, { workspace: wsName, routingKey, label: entry.bridge.label });
                  }
                }

                if (entry) {
                  await pool.send(entry.routingKey, body.text, `web-${randomUUID()}`, { webOnly: true });
                  writeAuditEntry('director.send', true, { target: targetName, bytes: Buffer.byteLength(body.text, 'utf-8') });
                  return Response.json({ ok: true, message: 'sent to pool director', label: entry.bridge.label });
                }
                writeAuditEntry('director.send', false, { target: targetName, reason: 'pool director not found' });
                return Response.json({ ok: false, message: `Workspace "${targetName}" not found` }, { status: 404 });
              }
              await director.send(body.text);
              writeAuditEntry('director.send', true, { target: 'main', bytes: Buffer.byteLength(body.text, 'utf-8') });
              return Response.json({ ok: true, message: 'sent' });
            } catch (err) {
              writeAuditEntry('director.send', false, { target: body.workspace ?? body.director ?? 'main', error: String(err) });
              return Response.json({ ok: false, message: String(err) }, { status: 500 });
            }
          }

          // POST /api/send-attachment — send image/file to user via messaging
          if (url.pathname === '/api/send-attachment' && req.method === 'POST') {
            const body = await req.json() as { path: string; source_director?: string; target_channel?: 'web' | 'messaging' };
            const sourceDirector = body.source_director ?? 'main';
            if (!body.path) {
              writeAuditEntry('attachment.send', false, { target: sourceDirector, path: null, targetChannel: body.target_channel ?? null, error: 'path is required' });
              return Response.json({ ok: false, error: 'path is required' }, { status: 400 });
            }

            // Path security: only allow local artifact roots and recorded task results.
            const resolved = resolve(body.path);
            if (!isAllowedAttachmentPath(resolved)) {
              writeAuditEntry('attachment.send', false, { target: sourceDirector, path: resolved, targetChannel: body.target_channel ?? null, error: 'Path not allowed' });
              return Response.json({ ok: false, error: `Path not allowed: ${resolved}` }, { status: 403 });
            }

            // File existence and size check
            if (!existsSync(resolved)) {
              writeAuditEntry('attachment.send', false, { target: sourceDirector, path: resolved, targetChannel: body.target_channel ?? null, error: 'File not found' });
              return Response.json({ ok: false, error: `File not found: ${resolved}` }, { status: 404 });
            }
            const stat = statSync(resolved);
            if (stat.size === 0) {
              writeAuditEntry('attachment.send', false, { target: sourceDirector, path: resolved, size: stat.size, targetChannel: body.target_channel ?? null, error: 'File is empty' });
              return Response.json({ ok: false, error: 'File is empty' }, { status: 400 });
            }

            if (!messaging && body.target_channel !== 'web') {
              writeAuditEntry('attachment.send', false, { target: sourceDirector, path: resolved, size: stat.size, targetChannel: body.target_channel ?? null, error: 'Messaging client not available' });
              return Response.json({ ok: false, error: 'Messaging client not available' }, { status: 503 });
            }

            // Send immediately as new message to target chat
            const ext = extname(resolved).toLowerCase();
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
            const isImage = imageExts.has(ext);

            try {
              // Resolve target chatId: pool Director → its group chat, main → lastChatId
              let targetChatId: string | null = null;
              if (body.target_channel === 'web') {
                targetChatId = 'web-console';
              } else if (sourceDirector && sourceDirector !== 'main' && pool) {
                targetChatId = pool.getChatIdByLabel(sourceDirector);
              }
              if (!targetChatId) {
                targetChatId = messaging?.getLastChatId() ?? null;
              }
              if (!targetChatId) {
                writeAuditEntry('attachment.send', false, { target: sourceDirector, path: resolved, size: stat.size, image: isImage, targetChannel: body.target_channel ?? null, error: 'No active chat to send to' });
                return Response.json({ ok: false, error: 'No active chat to send to' }, { status: 400 });
              }

              // Try to get the messageId of the currently-processing user message for reply threading.
              // Only fall back to main queue when source IS main — otherwise the reply API
              // routes by parent-message chat, sending the attachment to the wrong conversation.
              let replyMessageId: string | null = null;
              if (sourceDirector && sourceDirector !== 'main' && pool) {
                replyMessageId = pool.getProcessingMessageIdByLabel(sourceDirector);
              } else {
                const peeked = queue.peek();
                replyMessageId = peeked?.messageId ?? null;
              }

              if (replyMessageId) {
                if (targetChatId === 'web-console') {
                  if (!webClientRef) throw new Error('Web messaging client not available');
                  if (isImage) await webClientRef.uploadAndReplyImage(replyMessageId, resolved);
                  else await webClientRef.uploadAndReplyFile(replyMessageId, resolved);
                } else if (isImage) {
                  if (!messaging) throw new Error('Messaging client not available');
                  await messaging.uploadAndReplyImage(replyMessageId, resolved);
                } else {
                  if (!messaging) throw new Error('Messaging client not available');
                  await messaging.uploadAndReplyFile(replyMessageId, resolved);
                }
              } else {
                if (targetChatId === 'web-console') {
                  if (!webClientRef) throw new Error('Web messaging client not available');
                  if (isImage) await webClientRef.uploadAndSendImage(targetChatId, resolved);
                  else await webClientRef.uploadAndSendFile(targetChatId, resolved);
                } else if (isImage) {
                  if (!messaging) throw new Error('Messaging client not available');
                  await messaging.uploadAndSendImage(targetChatId, resolved);
                } else {
                  if (!messaging) throw new Error('Messaging client not available');
                  await messaging.uploadAndSendFile(targetChatId, resolved);
                }
              }
              const targetChannel = targetChatId === 'web-console' ? 'web' : 'messaging';
              const delivery = {
                path: resolved,
                source_director: sourceDirector,
                target_channel: targetChannel,
                target_chat_id: targetChatId,
                size: stat.size,
                image: isImage,
                reply: !!replyMessageId,
                target_chat_available: !!targetChatId,
              };
              writeAuditEntry('attachment.send', true, { target: sourceDirector, path: resolved, size: stat.size, image: isImage, reply: !!replyMessageId, targetChannel, targetChatId });
              return Response.json({ success: true, delivery });
            } catch (err) {
              console.error('[console] send-attachment failed:', err);
              writeAuditEntry('attachment.send', false, { target: sourceDirector, path: resolved, targetChannel: body.target_channel ?? null, error: String(err) });
              return Response.json({ error: String(err) }, { status: 500 });
            }
          }

          if (url.pathname === '/api/flush' && req.method === 'POST') {
            const result = await handleCommand('flush');
            return Response.json(result);
          }
          if (url.pathname === '/api/clear' && req.method === 'POST') {
            const result = await handleCommand('clear');
            return Response.json(result);
          }
          if (url.pathname === '/api/esc' && req.method === 'POST') {
            const result = await handleCommand('esc');
            return Response.json(result);
          }
          if (url.pathname === '/api/session-restart' && req.method === 'POST') {
            const result = await handleCommand('session-restart');
            return Response.json(result);
          }
          if (url.pathname.startsWith('/api/queue/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
            const correlationId = decodeURIComponent(url.pathname.slice('/api/queue/'.length, -'/cancel'.length));
            const headId = queue.peek()?.correlationId;
            const cancelled = queue.cancel(correlationId);
            if (!cancelled) return Response.json({ ok: false, error: 'queue item not found or already cancelled' }, { status: 404 });
            if (headId === correlationId) await director.interrupt();
            writeAuditEntry('queue.cancel', true, { target: 'main', correlationId, messageId: cancelled.messageId, interrupted: headId === correlationId });
            return Response.json({ ok: true, item: { correlationId, messageId: cancelled.messageId, interrupted: headId === correlationId } });
          }
          if (url.pathname === '/api/queue/clear' && req.method === 'POST') {
            const cleared = queue.clearAll();
            writeAuditEntry('queue.clear', true, { target: 'main', cleared: cleared.length });
            return Response.json({ ok: true, cleared: cleared.length });
          }
          if (url.pathname === '/api/directors/queue/cancel' && req.method === 'POST') {
            const body = await req.json() as { director_label?: string; director?: string; correlation_id?: string; correlationId?: string };
            const directorLabel = (body.director_label ?? body.director ?? '').trim();
            const correlationId = (body.correlation_id ?? body.correlationId ?? '').trim();
            if (!directorLabel || !correlationId) {
              writeAuditEntry('queue.cancel', false, { target: directorLabel || null, correlationId: correlationId || null, error: 'missing director_label or correlation_id' });
              return Response.json({ ok: false, error: 'director_label and correlation_id are required' }, { status: 400 });
            }
            if (!pool) {
              writeAuditEntry('queue.cancel', false, { target: directorLabel, correlationId, error: 'pool unavailable' });
              return Response.json({ ok: false, error: 'director pool unavailable' }, { status: 503 });
            }
            const cancelled = await pool.cancelQueuedByLabel(directorLabel, correlationId);
            if (!cancelled) {
              writeAuditEntry('queue.cancel', false, { target: directorLabel, correlationId, error: 'queue item not found or already cancelled' });
              return Response.json({ ok: false, error: 'queue item not found or already cancelled' }, { status: 404 });
            }
            writeAuditEntry('queue.cancel', true, {
              target: directorLabel,
              correlationId,
              messageId: cancelled.item.messageId,
              interrupted: cancelled.interrupted,
            });
            return Response.json({
              ok: true,
              item: {
                director_label: cancelled.label,
                groupName: cancelled.groupName,
                correlationId,
                messageId: cancelled.item.messageId,
                interrupted: cancelled.interrupted,
              },
            });
          }
          if (url.pathname === '/api/work-context' && req.method === 'GET') {
            return Response.json(buildWorkContext());
          }
          if (url.pathname === '/api/workspaces' && req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as { name?: unknown; cwd?: string; agent?: string };
            try {
              return Response.json(createWorkspace(body.name, body.cwd, body.agent));
            } catch (err) {
              return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
            }
          }
          if (url.pathname === '/api/workspaces/config' && req.method === 'PUT') {
            const body = await req.json().catch(() => ({})) as { name?: string; cwd?: string; agent?: string };
            const wsName = sanitizeWorkspaceName(body.name);
            if (!wsName) {
              return Response.json({ error: 'Workspace name is required' }, { status: 400 });
            }
            const workspacePath = join(config.director.persona_dir, 'workspaces', wsName);
            if (!existsSync(workspacePath)) {
              return Response.json({ error: `Workspace not found: ${wsName}` }, { status: 404 });
            }
            let resolvedCwd: string | undefined;
            if (body.cwd && typeof body.cwd === 'string') {
              resolvedCwd = resolve(expandConsolePath(body.cwd.trim()));
              if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
                return Response.json({ error: `Invalid cwd: directory does not exist: ${resolvedCwd}` }, { status: 400 });
              }
            }
            const existing = getWorkspaceConfig(wsName);
            const wsConfig: WorkspaceConfig = { ...existing, cwd: resolvedCwd };
            if (body.agent !== undefined) wsConfig.agent = body.agent?.trim() || undefined;
            setWorkspaceConfig(wsName, wsConfig);
            return Response.json({ ok: true, name: wsName, config: wsConfig });
          }
          if (url.pathname === '/api/browse' && req.method === 'GET') {
            const rawPath = url.searchParams.get('path') || '~';
            const resolved = resolve(expandConsolePath(rawPath));
            if (resolved.includes('\0')) {
              return Response.json({ error: 'Invalid path' }, { status: 400 });
            }
            try {
              if (!statSync(resolved).isDirectory()) {
                return Response.json({ error: 'Not a directory' }, { status: 400 });
              }
            } catch {
              return Response.json({ error: 'Path does not exist' }, { status: 404 });
            }
            try {
              const entries = readdirSync(resolved, { withFileTypes: true });
              const dirs = entries
                .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                .map(e => ({ name: e.name, path: join(resolved, e.name) }))
                .sort((a, b) => a.name.localeCompare(b.name));
              return Response.json({
                current: resolved,
                parent: dirname(resolved) !== resolved ? dirname(resolved) : null,
                directories: dirs,
              });
            } catch (err) {
              return Response.json({ error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}` }, { status: 403 });
            }
          }
          // Message history and session APIs
          if (url.pathname === '/api/messages' && req.method === 'GET') {
            const limit = Number(url.searchParams.get('limit') ?? 100);
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            const directorLabel = url.searchParams.get('director') ?? undefined;
            const workspace = url.searchParams.get('workspace') ?? undefined;
            // Resolve director label from workspace name if provided
            let effectiveLabel = directorLabel;
            if (!effectiveLabel && workspace && workspace !== 'main') {
              const match = pool?.getPoolStatus().find((e) => {
                const safeName = e.groupName.replace(/[\/\\:*?"<>|]/g, '_');
                return workspace === safeName || workspace === e.groupName;
              });
              effectiveLabel = match?.label;
            }
            const target = resolveDirectorLogTarget(effectiveLabel, director, pool);
            return Response.json(parseConversationLogFiles(target.inputLogs, target.outputLogs, limit, sessionId));
          }
          if (url.pathname === '/api/sessions' && req.method === 'GET') {
            const directorLabel = url.searchParams.get('director') ?? undefined;
            const workspace = url.searchParams.get('workspace') ?? undefined;

            // Resolve workspace name: direct param, or derive from director label
            let wsName: string;
            if (workspace) {
              wsName = workspace;
            } else if (!directorLabel || directorLabel === 'main') {
              wsName = 'main';
            } else {
              const poolEntry = pool?.getPoolStatus().find((e) => e.label === directorLabel);
              wsName = poolEntry?.groupName ?? directorLabel;
            }

            const dbRows = listSessionsFromDb(wsName);
            const sessions = dbRows.map((r) => ({
              sessionId: r.session_id,
              sessionName: r.session_name ?? undefined,
              alive: r.alive === 1,
              messageCount: r.message_count,
              firstMessageAt: r.first_message_at ?? undefined,
              lastMessageAt: r.last_message_at ?? undefined,
            }));

            // Fallback: if DB is empty, parse logs (for pre-migration data)
            if (sessions.length === 0) {
              const target = resolveDirectorLogTarget(directorLabel, director, pool);
              const parsed = parseSessionsFiles(target.outputLogs);
              const nameMap = getState<Record<string, string>>('session:names') ?? {};
              for (const s of parsed) {
                if (!s.sessionName && nameMap[s.sessionId]) {
                  s.sessionName = nameMap[s.sessionId];
                }
              }
              return Response.json(parsed);
            }

            // Merge live director status for current session
            const resolvedLabel = directorLabel ?? 'main';
            const poolEntry = resolvedLabel === 'main'
              ? undefined
              : pool?.getPoolStatus().find((e) => e.label === resolvedLabel);
            const activePoolEntry = poolEntry ? pool?.get(poolEntry.routingKey) : undefined;
            const ds = resolvedLabel === 'main' ? director.getStatus() : activePoolEntry?.bridge.getStatus();
            if (ds?.sessionId) {
              const live = sessions.find(s => s.sessionId === ds.sessionId);
              if (live) {
                if (ds.sessionName) live.sessionName = ds.sessionName;
                live.alive = true;
              } else {
                sessions.unshift({
                  sessionId: ds.sessionId,
                  sessionName: ds.sessionName ?? undefined,
                  alive: true,
                  messageCount: 0,
                  firstMessageAt: undefined,
                  lastMessageAt: new Date().toISOString(),
                });
              }
            }
            return Response.json(sessions);
          }
          if (url.pathname === '/api/sessions/name' && req.method === 'PUT') {
            const body = await req.json() as { director?: string; session_id?: string; session_name?: string | null };
            const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
            if (!sessionId) return Response.json({ error: 'session_id is required' }, { status: 400 });
            const rawName = typeof body.session_name === 'string' ? body.session_name.trim() : '';
            if (rawName.length > 80) return Response.json({ error: 'session_name is too long' }, { status: 413 });

            const nameMap = { ...(getState<Record<string, string>>('session:names') ?? {}) };
            if (rawName) nameMap[sessionId] = rawName;
            else delete nameMap[sessionId];
            setState('session:names', nameMap);
            try { setSessionNameInDb(sessionId, rawName || null); } catch { /* best-effort */ }

            const directorLabel = typeof body.director === 'string' && body.director.trim() ? body.director.trim() : 'main';
            let targetDirector = director;
            if (directorLabel !== 'main' && pool) {
              const entry = pool.getPoolStatus().find((e) => e.label === directorLabel);
              if (entry) {
                const poolEntry = pool.get(entry.routingKey);
                if (poolEntry) targetDirector = poolEntry.bridge;
              }
            }
            const liveUpdated = targetDirector.setSessionDisplayName(sessionId, rawName || null);
            writeAuditEntry('session.rename', true, { target: sessionId, director: directorLabel, sessionName: rawName || null, liveUpdated });
            return Response.json({ ok: true, sessionId, sessionName: rawName || null, liveUpdated });
          }
          // Persona orchestration APIs for Codex app / MCP clients
          if (url.pathname === '/api/persona/roles' && req.method === 'GET') {
            return Response.json({ roles: listPersonaRoles(config.director.persona_dir) });
          }
          if (url.pathname === '/api/persona/prompt' && req.method === 'GET') {
            const role = url.searchParams.get('role') ?? 'director';
            const systemPromptFile = url.searchParams.get('system_prompt_file');
            return Response.json(buildPersonaPromptBundle(config.director.persona_dir, role, { systemPromptFile }));
          }
          if (url.pathname === '/api/persona/docs' && req.method === 'GET') {
            return Response.json({ root: config.director.persona_dir, docs: listPersonaDocs() });
          }
          if (url.pathname === '/api/persona/docs/content' && req.method === 'GET') {
            const relativePath = url.searchParams.get('path') ?? '';
            try {
              const safe = normalizePersonaDocPath(relativePath);
              const filePath = resolvePersonaDocPath(safe);
              if (!existsSync(filePath) || !statSync(filePath).isFile()) {
                return Response.json({ error: 'not found' }, { status: 404 });
              }
              if (statSync(filePath).size > 1024 * 1024) {
                return Response.json({ error: 'file is too large to preview' }, { status: 413 });
              }
              return Response.json({
                path: safe,
                category: personaDocCategory(safe),
                editable: isPersonaDocEditable(safe),
                content: readFileSync(filePath, 'utf-8'),
              });
            } catch (err) {
              return Response.json({ error: String(err) }, { status: 400 });
            }
          }
          if (url.pathname === '/api/persona/docs/content' && req.method === 'PUT') {
            const body = await req.json() as { path?: string; content?: string };
            if (!body.path) {
              writeAuditEntry('persona.doc.update', false, { target: null, error: 'path is required' });
              return Response.json({ ok: false, error: 'path is required' }, { status: 400 });
            }
            if (typeof body.content !== 'string') {
              writeAuditEntry('persona.doc.update', false, { target: body.path, error: 'content must be a string' });
              return Response.json({ ok: false, error: 'content must be a string' }, { status: 400 });
            }
            if (body.content.length > 512 * 1024) {
              writeAuditEntry('persona.doc.update', false, { target: body.path, error: 'content is too large', bytes: Buffer.byteLength(body.content, 'utf-8') });
              return Response.json({ ok: false, error: 'content is too large' }, { status: 413 });
            }
            try {
              const safe = normalizePersonaDocPath(body.path);
              if (!isPersonaDocEditable(safe)) {
                writeAuditEntry('persona.doc.update', false, { target: safe, error: 'only markdown persona docs are editable' });
                return Response.json({ ok: false, error: 'only markdown persona docs are editable' }, { status: 400 });
              }
              const filePath = resolvePersonaDocPath(safe);
              mkdirSync(dirname(filePath), { recursive: true });
              writeFileSync(filePath, body.content, 'utf-8');
              writeAuditEntry('persona.doc.update', true, { target: safe, path: filePath, bytes: Buffer.byteLength(body.content, 'utf-8') });
              return Response.json({ ok: true, path: safe, content: body.content });
            } catch (err) {
              writeAuditEntry('persona.doc.update', false, { target: body.path, error: String(err) });
              return Response.json({ ok: false, error: String(err) }, { status: 400 });
            }
          }
          if (url.pathname === '/api/persona/session-links' && req.method === 'GET') {
            const links = getState<Record<string, PersonaSessionLink>>('persona:session-links') ?? {};
            const channel = url.searchParams.get('channel');
            const externalId = url.searchParams.get('external_id');
            if (channel && externalId) {
              return Response.json(links[sessionLinkKey(channel, externalId)] ?? null);
            }
            return Response.json({ links });
          }
          if (url.pathname === '/api/persona/session-links' && req.method === 'POST') {
            const body = await req.json() as {
              channel?: string;
              external_id?: string;
              persona_session_id?: string | null;
              codex_thread_id?: string | null;
              director_label?: string | null;
              role?: string | null;
            };
            if (!body.channel || !body.external_id) {
              writeAuditEntry('persona.session_link.upsert', false, {
                channel: body.channel ?? null,
                externalId: body.external_id ?? null,
                directorLabel: body.director_label ?? null,
                role: body.role ?? null,
                error: 'channel and external_id are required',
              });
              return Response.json({ ok: false, error: 'channel and external_id are required' }, { status: 400 });
            }
            const links = upsertSessionLink(getState<Record<string, PersonaSessionLink>>('persona:session-links'), {
              channel: body.channel,
              externalId: body.external_id,
              personaSessionId: body.persona_session_id ?? null,
              codexThreadId: body.codex_thread_id ?? null,
              directorLabel: body.director_label ?? null,
              role: body.role ?? null,
            });
            setState('persona:session-links', links);
            writeAuditEntry('persona.session_link.upsert', true, { target: sessionLinkKey(body.channel, body.external_id), channel: body.channel, externalId: body.external_id, directorLabel: body.director_label ?? null, role: body.role ?? null });
            return Response.json(links[sessionLinkKey(body.channel, body.external_id)]);
          }
          if (url.pathname === '/api/persona/session-links' && req.method === 'DELETE') {
            const channel = url.searchParams.get('channel')?.trim();
            const externalId = url.searchParams.get('external_id')?.trim();
            if (!channel || !externalId) {
              writeAuditEntry('persona.session_link.delete', false, {
                channel: channel || null,
                externalId: externalId || null,
                error: 'channel and external_id are required',
              });
              return Response.json({ ok: false, error: 'channel and external_id are required' }, { status: 400 });
            }
            const links = { ...(getState<Record<string, PersonaSessionLink>>('persona:session-links') ?? {}) };
            const key = sessionLinkKey(channel, externalId);
            const existing = links[key] ?? null;
            if (!existing) {
              writeAuditEntry('persona.session_link.delete', false, { target: key, channel, externalId, error: 'session link not found' });
              return Response.json({ ok: false, deleted: false, key, error: `session link not found: ${key}` }, { status: 404 });
            }
            delete links[key];
            setState('persona:session-links', links);
            writeAuditEntry('persona.session_link.delete', true, { target: key, channel, externalId });
            return Response.json({ ok: true, deleted: true, key });
          }
          if (url.pathname === '/api/directors/switch-agent' && req.method === 'POST') {
            const body = await req.json() as { director_label?: string; agent?: string };
            try {
              const result = await switchDirectorAgent(body.director_label ?? 'main', body.agent ?? '');
              writeAuditEntry('director.switch_agent', true, { target: result.director_label, agent: result.agent, agentType: result.agent_type });
              return Response.json(result);
            } catch (err) {
              const error = err as Error & { status?: number };
              writeAuditEntry('director.switch_agent', false, { target: body.director_label ?? 'main', agent: body.agent ?? '', error: error.message || String(error) });
              return Response.json({ ok: false, error: error.message || String(error) }, { status: error.status ?? 500 });
            }
          }
          if (url.pathname === '/api/directors/switch-persona' && req.method === 'POST') {
            const body = await req.json() as { director_label?: string; role?: string };
            try {
              const result = await switchDirectorPersona(body.director_label ?? 'main', body.role ?? '');
              writeAuditEntry('director.switch_persona', true, { target: result.director_label, role: result.role });
              return Response.json(result);
            } catch (err) {
              const error = err as Error & { status?: number };
              writeAuditEntry('director.switch_persona', false, { target: body.director_label ?? 'main', role: body.role ?? '', error: error.message || String(error) });
              return Response.json({ ok: false, error: error.message || String(error) }, { status: error.status ?? 500 });
            }
          }
          if (url.pathname === '/api/directors/command' && req.method === 'POST') {
            const body = await req.json() as { director_label?: string; command?: string };
            try {
              const result = await runRuntimeDirectorCommand(body.director_label ?? 'main', body.command ?? '');
              return Response.json(result);
            } catch (err) {
              const error = err as Error & { status?: number };
              let auditAction = 'director.command_unknown';
              try {
                if (body.command) auditAction = runtimeDirectorAuditAction(normalizeRuntimeDirectorCommand(body.command));
              } catch {
                // Keep the unknown-command audit action.
              }
              writeAuditEntry(
                auditAction,
                false,
                { target: body.director_label ?? 'main', command: body.command ?? '', error: error.message || String(error) },
              );
              return Response.json({ ok: false, error: error.message || String(error) }, { status: error.status ?? 500 });
            }
          }
          if (url.pathname === '/api/directors/shutdown' && req.method === 'POST') {
            const body = await req.json() as { director_label?: string };
            const targetLabel = (body.director_label ?? '').trim();
            try {
              if (!targetLabel) {
                const err = new Error('director_label is required') as Error & { status?: number };
                err.status = 400;
                throw err;
              }
              if (targetLabel === 'main') {
                const err = new Error('main Director shutdown is not supported from web console') as Error & { status?: number };
                err.status = 400;
                throw err;
              }
              if (!pool) {
                const err = new Error('Director pool is unavailable') as Error & { status?: number };
                err.status = 503;
                throw err;
              }
              const target = pool.getPoolStatus().find((entry) => entry.label === targetLabel && !entry.closed);
              if (!target) {
                const err = new Error(`Director "${targetLabel}" is not active`) as Error & { status?: number };
                err.status = 404;
                throw err;
              }
              await pool.shutdown(target.routingKey);
              writeAuditEntry('director.shutdown', true, { target: targetLabel, routingKey: target.routingKey, groupName: target.groupName ?? null });
              return Response.json({ ok: true, director_label: targetLabel, routing_key: target.routingKey });
            } catch (err) {
              const error = err as Error & { status?: number };
              writeAuditEntry('director.shutdown', false, { target: targetLabel || null, error: error.message || String(error) });
              return Response.json({ ok: false, error: error.message || String(error) }, { status: error.status ?? 500 });
            }
          }
          if (url.pathname === '/api/codex/inject' && req.method === 'POST') {
            const body = await req.json() as {
              thread_id?: string;
              session_id?: string;
              text?: string;
              cwd?: string;
              agent?: string;
              timeout_ms?: number;
            };
            const threadId = (body.thread_id ?? body.session_id ?? '').trim();
            const text = (body.text ?? '').trim();
            if (!threadId || !text) {
              return Response.json({ error: 'thread_id/session_id and text are required' }, { status: 400 });
            }
            try {
              const agent = resolveAgentProvider(config.agents, 'director', body.agent || 'codex');
              const injector = new CodexThreadInjector({
                logDir: join(getLogDir(), 'codex-thread-injector'),
                directorConfig: config.director,
                agent,
              });
              const result = await injector.injectUserMessage({
                threadId,
                text,
                cwd: body.cwd,
                timeoutMs: body.timeout_ms,
              });
              writeAuditEntry('codex.inject', true, { target: threadId, cwd: body.cwd ?? null, agent: agent.name });
              return Response.json(result);
            } catch (err) {
              const error = err as Error & { status?: number };
              writeAuditEntry('codex.inject', false, { target: threadId, cwd: body.cwd ?? null, error: error.message || String(error) });
              return Response.json({ ok: false, error: error.message || String(error) }, { status: error.status ?? 500 });
            }
          }
          // Task API routes
          if (url.pathname === '/api/tasks' && req.method === 'POST') {
            const body = await req.json() as CreateTaskInput;
            if (!body.role || !body.prompt || !body.description) {
              writeAuditEntry('task.create', false, {
                role: body.role ?? null,
                sourceDirector: body.source_director ?? null,
                error: 'role, description, prompt are required',
              });
              return Response.json({ ok: false, error: 'role, description, prompt are required' }, { status: 400 });
            }
            const task = createTask(body);
            runCreatedTask(task);
            writeAuditEntry('task.create', true, { target: task.id, role: task.role, agent: task.agent, sourceDirector: task.source_director });
            return Response.json(task);
          }
          if (url.pathname === '/api/tasks' && req.method === 'GET') {
            const status = url.searchParams.get('status') ?? undefined;
            const role = url.searchParams.get('role') ?? undefined;
            const sourceDirector = url.searchParams.get('source_director') ?? undefined;
            const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
            return Response.json(listTasks({ status, role, sourceDirector, limit }));
          }
          if (url.pathname === '/api/tasks/cleanup' && req.method === 'GET') {
            const olderThanDays = Number(url.searchParams.get('older_than_days') ?? 30);
            const status = (url.searchParams.get('status') ?? 'terminal') as TaskCleanupStatus;
            return Response.json(previewTaskCleanup({ olderThanDays, status }));
          }
          if (url.pathname === '/api/tasks/cleanup' && req.method === 'POST') {
            const body = await req.json() as { older_than_days?: number; olderThanDays?: number; status?: TaskCleanupStatus; confirm?: boolean };
            if (body.confirm !== true) {
              writeAuditEntry('task.cleanup', false, { reason: 'confirmation required', olderThanDays: body.older_than_days ?? body.olderThanDays, status: body.status ?? 'terminal' });
              return Response.json({ error: 'confirm is required' }, { status: 400 });
            }
            const result = cleanupTaskHistory({
              olderThanDays: body.older_than_days ?? body.olderThanDays ?? 30,
              status: body.status ?? 'terminal',
            });
            writeAuditEntry('task.cleanup', true, {
              deletedCount: result.deletedCount,
              eligibleCount: result.eligibleCount,
              cutoff: result.cutoff,
              status: result.status,
              olderThanDays: result.olderThanDays,
            });
            return Response.json(result);
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/output') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/output'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'task not found' }, { status: 404 });
            if (!task.result_file) return Response.json({ error: 'no result file' }, { status: 404 });
            try {
              const content = readFileSync(task.result_file, 'utf-8');
              return Response.json({ content, path: task.result_file });
            } catch {
              return Response.json({ error: 'result file not readable' }, { status: 404 });
            }
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/cancel'.length);
            const task = getTask(taskId);
            if (!task) {
              writeAuditEntry('task.cancel', false, { target: taskId, error: 'task not found' });
              return Response.json({ ok: false, taskId, error: `task not found: ${taskId}` }, { status: 404 });
            }
            const ok = cancelTaskInDb(taskId);
            if (!ok) {
              writeAuditEntry('task.cancel', false, { target: taskId, status: task.status, error: 'task is not active' });
              return Response.json({ ok: false, taskId, error: `task is not active: ${task.status}` }, { status: 409 });
            }
            if (taskRunner) taskRunner.cancelTask(taskId);
            writeAuditEntry('task.cancel', true, { target: taskId });
            return Response.json({ ok, taskId });
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/retry') && req.method === 'POST') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/retry'.length);
            const original = getTask(taskId);
            if (!original) {
              writeAuditEntry('task.retry', false, { target: taskId, error: 'task not found' });
              return Response.json({ ok: false, taskId, error: `task not found: ${taskId}` }, { status: 404 });
            }
            const extra: Record<string, unknown> = { ...((original.extra ?? {}) as Record<string, unknown>), retried_from: original.id };
            const task = createTask({
              type: (original.type === 'cron' ? 'cron' : 'role') as CreateTaskInput['type'],
              role: original.role,
              agent: original.agent ?? undefined,
              model: extra.model as string | undefined,
              description: `Retry: ${original.description}`,
              prompt: original.prompt,
              max_retry: original.max_retry,
              project_dir: extra.project_dir as string | undefined,
              timeout_ms: original.timeout_ms ?? undefined,
              source_director: original.source_director ?? undefined,
              extra,
            });
            runCreatedTask(task);
            writeAuditEntry('task.retry', true, { target: task.id, originalTaskId: original.id, role: task.role, agent: task.agent });
            return Response.json(task);
          }
          if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/logs') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length, -'/logs'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'task not found' }, { status: 404 });
            const afterLine = Number(url.searchParams.get('after') ?? 0);
            const logData = parseTaskLog(taskId, afterLine);
            return Response.json(logData);
          }
          if (url.pathname.startsWith('/api/tasks/') && req.method === 'GET') {
            const taskId = url.pathname.slice('/api/tasks/'.length);
            const task = getTask(taskId);
            if (!task) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(task);
          }
          // Cron Jobs API routes
          if (url.pathname === '/api/cron-jobs' && req.method === 'GET') {
            return Response.json(listCronJobs());
          }
          if (url.pathname === '/api/cron-jobs' && req.method === 'POST') {
            const body = await req.json() as CreateCronJobInput;
            if (!body.name || !body.role || !body.prompt || !body.schedule || !body.description) {
              writeAuditEntry('cron.create', false, {
                name: body.name ?? null,
                role: body.role ?? null,
                actionType: body.action_type ?? null,
                error: 'name, role, description, prompt, schedule are required',
              });
              return Response.json({ ok: false, error: 'name, role, description, prompt, schedule are required' }, { status: 400 });
            }
            const job = createCronJob(body);
            writeAuditEntry('cron.create', true, { target: job.id, name: job.name, actionType: job.action_type, schedule: job.schedule });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && url.pathname.endsWith('/toggle') && req.method === 'POST') {
            const id = url.pathname.slice('/api/cron-jobs/'.length, -'/toggle'.length);
            const job = toggleCronJob(id);
            if (!job) {
              writeAuditEntry('cron.toggle', false, { target: id, error: 'cron job not found' });
              return Response.json({ ok: false, id, error: `cron job not found: ${id}` }, { status: 404 });
            }
            writeAuditEntry('cron.toggle', true, { target: id, enabled: job.enabled });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && url.pathname.endsWith('/run') && req.method === 'POST') {
            const id = url.pathname.slice('/api/cron-jobs/'.length, -'/run'.length);
            const job = getCronJob(id);
            if (!job) {
              writeAuditEntry('cron.run_now', false, { target: id, error: 'cron job not found' });
              return Response.json({ ok: false, id, error: `cron job not found: ${id}` }, { status: 404 });
            }
            try {
              const result = await runCronJobNow(job);
              writeAuditEntry('cron.run_now', true, { target: id, actionType: job.action_type, result });
              return Response.json(result);
            } catch (err) {
              const error = err as Error & { status?: number };
              writeAuditEntry('cron.run_now', false, { target: id, actionType: job.action_type, error: error.message || String(error) });
              return Response.json({ ok: false, error: error.message || String(error) }, { status: error.status ?? 500 });
            }
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'GET') {
            const id = url.pathname.slice('/api/cron-jobs/'.length);
            const job = getCronJob(id);
            if (!job) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'PUT') {
            const id = url.pathname.slice('/api/cron-jobs/'.length);
            const body = await req.json() as Partial<CreateCronJobInput>;
            const job = updateCronJob(id, body);
            if (!job) {
              writeAuditEntry('cron.update', false, { target: id, error: 'cron job not found' });
              return Response.json({ ok: false, id, error: `cron job not found: ${id}` }, { status: 404 });
            }
            writeAuditEntry('cron.update', true, { target: id, name: job.name, schedule: job.schedule, enabled: job.enabled });
            return Response.json(job);
          }
          if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'DELETE') {
            const id = url.pathname.slice('/api/cron-jobs/'.length);
            const ok = deleteCronJob(id);
            if (!ok) {
              writeAuditEntry('cron.delete', false, { target: id, error: 'cron job not found' });
              return Response.json({ ok: false, id, error: `cron job not found: ${id}` }, { status: 404 });
            }
            writeAuditEntry('cron.delete', true, { target: id });
            return Response.json({ ok: true, id });
          }
          // Web session API routes
          if (url.pathname === '/api/web-sessions' && req.method === 'POST') {
            if (!pool) return Response.json({ error: 'Pool not available' }, { status: 503 });
            try {
              const id = randomUUID().slice(0, 8);
              const routingKey = `web-${id}`;
              const timeStr = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
              const entry = await pool.getOrCreate(routingKey, {
                groupName: `Web Chat ${timeStr}`,
                feishuChatId: 'web-console',
              });
              writeAuditEntry('web_session.create', true, { target: entry.bridge.label, routingKey, groupName: entry.groupName });
              return Response.json({ ok: true, routingKey, label: entry.bridge.label });
            } catch (err) {
              writeAuditEntry('web_session.create', false, { error: String(err) });
              return Response.json({ ok: false, error: String(err) }, { status: 500 });
            }
          }
          if (url.pathname.startsWith('/api/web-sessions/') && req.method === 'DELETE') {
            if (!pool) return Response.json({ error: 'Pool not available' }, { status: 503 });
            const routingKey = decodeURIComponent(url.pathname.slice('/api/web-sessions/'.length));
            if (!routingKey) {
              writeAuditEntry('web_session.close', false, { target: null, routingKey: null, error: 'routing key is required' });
              return Response.json({ ok: false, error: 'routing key is required' }, { status: 400 });
            }
            try {
              const entry = pool.get(routingKey);
              if (!entry) {
                writeAuditEntry('web_session.close', false, { target: routingKey, routingKey, error: 'web session not found' });
                return Response.json({ ok: false, error: `web session not found: ${routingKey}` }, { status: 404 });
              }
              await pool.shutdown(routingKey);
              writeAuditEntry('web_session.close', true, { target: entry.bridge.label, routingKey, groupName: entry.groupName });
              return Response.json({ ok: true });
            } catch (err) {
              writeAuditEntry('web_session.close', false, { target: routingKey, routingKey, error: String(err) });
              return Response.json({ ok: false, error: String(err) }, { status: 500 });
            }
          }
          // POST /api/webhook — receive external notification and forward to user via messaging
          if (url.pathname === '/api/webhook' && req.method === 'POST') {
            const body = await req.json() as { message?: string };
            if (!body.message) {
              return Response.json({ ok: false, error: 'message is required' }, { status: 400 });
            }
            const preview = body.message.length > 50 ? body.message.slice(0, 50) + '...' : body.message;
            console.log(`[webhook] received: ${preview}`);
            try {
              const chatId = messaging?.getLastChatId();
              if (chatId && messaging) {
                await messaging.sendMessage(chatId, body.message);
                return Response.json({ ok: true });
              } else {
                console.warn('[webhook] no messaging channel available, message dropped');
                return Response.json({ ok: false, error: 'no messaging channel available' }, { status: 503 });
              }
            } catch (err) {
              return Response.json({ ok: false, error: String(err) }, { status: 500 });
            }
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
        // Clean up pending chat entries for this connection
        for (const [id, entry] of messageWsMap) {
          if (entry.ws === ws) messageWsMap.delete(id);
        }
      },
      async message(ws, data) {
        try {
          const msg = JSON.parse(String(data));
          const quotedText = typeof msg.quotedText === 'string'
            ? msg.quotedText.trim()
            : typeof msg.quoted_text === 'string'
              ? msg.quoted_text.trim()
              : '';
          const formatWebQuote = (raw: string): string => {
            const maxLen = config.director.quote_max_length;
            const truncated = maxLen > 0 && raw.length > maxLen
              ? raw.slice(0, maxLen) + '...(truncated)'
              : raw;
            return `[引用上文]\n${truncated.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
          };
          if (msg.type === 'command' && msg.command) {
            const result = await handleCommand(msg.command);
            ws.send(JSON.stringify({
              type: 'command_result',
              command: msg.command,
              ...result,
            }));
          } else if (msg.type === 'chat' && msg.text) {
            // Web chat 消息 — route to specific Director if specified
            const targetLabel: string | null = msg.director ?? null;
            if (targetLabel && pool) {
              // Route to pool Director via queue (ensures response correlation)
              const poolStatus = pool.getPoolStatus().find((e) => e.label === targetLabel);
              if (poolStatus) {
                const messageId = msg.messageId || `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                messageWsMap.set(messageId, { ws, createdAt: Date.now() });
                try {
                  await pool.send(poolStatus.routingKey, quotedText ? formatWebQuote(quotedText) + msg.text : msg.text, messageId);
                } catch (err) {
                  console.error(`[console] Web chat send to pool "${targetLabel}" failed:`, err);
                }
                return;
              }
              console.warn(`[console] Pool Director "${targetLabel}" not found, falling back to main`);
            }
            // Fall back to main Director via MessagingClient handler
            const messageId = msg.messageId || `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            messageWsMap.set(messageId, { ws, createdAt: Date.now() });
            for (const handler of chatHandlers) {
              try {
                await handler({
                  text: msg.text,
                  messageId,
                  chatId: 'web-console',
                  chatType: 'p2p',
                  quotedText: quotedText || undefined,
                });
              } catch (err) {
                console.error('[console] Web chat handler error:', err);
              }
            }
          }
        } catch {
          // 忽略无效消息
        }
      },
    },
  });

  console.log(`[console] Web console started at http://localhost:${port}`);

  function webAttachmentPayload(filePath: string, reply: boolean): string {
    const resolved = resolve(filePath);
    if (!isAllowedAttachmentPath(resolved) || !existsSync(resolved)) {
      throw new Error(`Web attachment path not available: ${resolved}`);
    }
    const stat = statSync(resolved);
    const kind = fileKind(resolved);
    return JSON.stringify({
      type: 'chat_attachment',
      messageId: null,
      file: {
        path: resolved,
        name: resolved.split('/').pop() ?? 'attachment',
        size: stat.size,
        kind,
        image: kind === 'image',
        reply,
        url: `/api/files/download?path=${encodeURIComponent(resolved)}`,
      },
    });
  }

  async function sendWebAttachmentToReply(messageId: string, filePath: string): Promise<void> {
    const entry = messageWsMap.get(messageId);
    if (!entry) {
      throw new Error('Web reply target is no longer connected');
    }
    entry.ws.send(webAttachmentPayload(filePath, true));
  }

  async function broadcastWebAttachment(filePath: string): Promise<string | null> {
    if (clients.size === 0) {
      throw new Error('No web client connected');
    }
    const payload = webAttachmentPayload(filePath, false);
    for (const ws of clients) {
      ws.send(payload);
    }
    return `web-attachment-${Date.now()}`;
  }

  // 返回 web 渠道的 MessagingClient
  const webClient: MessagingClient = {
    start() { /* already started above */ },
    onMessage(handler) { chatHandlers.push(handler); },
    async reply(messageId, text) {
      const entry = messageWsMap.get(messageId);
      if (entry) {
        try { entry.ws.send(JSON.stringify({ type: 'chat_reply', messageId, text })); } catch { /* client gone */ }
        messageWsMap.delete(messageId);
      }
    },
    async sendMessage(_chatId, text) {
      const payload = JSON.stringify({ type: 'chat_reply', messageId: null, text });
      for (const ws of clients) {
        try { ws.send(payload); } catch { /* client gone */ }
      }
      return null;
    },
    async addReaction() { /* no-op for web */ },
    async uploadAndReplyImage(messageId, filePath) { await sendWebAttachmentToReply(messageId, filePath); },
    async uploadAndReplyFile(messageId, filePath) { await sendWebAttachmentToReply(messageId, filePath); },
    async uploadAndSendImage(_chatId, filePath) { return broadcastWebAttachment(filePath); },
    async uploadAndSendFile(_chatId, filePath) { return broadcastWebAttachment(filePath); },
    getLastChatId() { return clients.size > 0 ? 'web-console' : null; },
    getConnectionStatus() { return clients.size > 0 ? 'connected' : 'disconnected'; },
  };
  webClientRef = webClient;
  return webClient;
}

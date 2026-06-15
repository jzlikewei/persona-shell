import { loadConfig, resolveAgentProvider, defaultConfigPath, type Config } from './config.js';
import { SessionBridge } from './session-bridge.js';
import { AgentRuntimePool } from './agent-runtime-pool.js';
import { SessionManager } from './session-manager.js';
import { WorkspaceRegistry } from './workspace-registry.js';
import { createFeishuClient } from './messaging/feishu.js';
import { MessagingRouter } from './messaging/messaging-router.js';
import type { IncomingMessage, StreamingReplyHandle, CardAction, MessagingClient } from './messaging/messaging.js';
import type { DirectorInputAttachment } from './director-input.js';
import { MessageQueue, type QueueItem } from './queue.js';
import { startConsole, type MetricsCollector } from './console.js';
import { ensureWebV2Dist } from './ensure-web-v2-dist.js';
import { TaskRunner, type TaskResult } from './task/task-runner.js';
import { spawnPersona } from './persona-process.js';
import { createInterface } from 'readline';
import { Scheduler } from './task/scheduler.js';
import { isBashAction, extractBashCommand, runBashAction } from './task/shell-bash.js';
import { resolveCronMessage } from './prompt-loader.js';
import { updateTask, listTasks, createTask, getTask, getState, setState, deleteState, listCronJobs, updateCronJob, createCronJob, deleteCronJob, toggleCronJob, initTaskStore, localNow, getSessionRecord, listSessionsFromDb, updateWorkspace as updateWorkspaceInDb, type TaskExtra } from './task/task-store.js';
import { writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, resolve } from 'path';
import { homedir } from 'os';
import { setLogLevel, log, initLogDir, getLogDir, cleanupOldLogs } from './logger.js';
import { parseShellRestartCommand, buildShellRestartBlockedMessage } from './shell-restart.js';
import { CodexThreadInjector } from './codex-thread-injector.js';
import type { DirectorDynamicToolCall, DirectorDynamicToolResult } from './director-session-adapter/index.js';
import { writeShellMcpConfig } from './mcp-config.js';
import { handlePersonaDynamicToolCall } from './persona-dynamic-tools.js';
import { buildFeishuConfigCard, type ConfigCardState } from './messaging/feishu-config-card.js';

// Prepend local timestamp (Asia/Shanghai) to all console output
for (const method of ['log', 'warn', 'error'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(`[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(',', '')}]`, ...args);
  };
}

async function main() {
  const configPath = defaultConfigPath();
  const config = loadConfig(configPath);
  const getFreshConfig = () => loadConfig(configPath);
  const getFreshAgents = () => getFreshConfig().agents;
  setLogLevel(config.logging.level);
  initLogDir(config.director.persona_dir);
  initTaskStore(config.director.persona_dir);

  // 启动时清理过期日志（默认 7 天）
  const cleaned = cleanupOldLogs(7);
  if (cleaned > 0) log.info(`[startup] Cleaned ${cleaned} old log file(s)`);

  const queue = new MessageQueue(join(getLogDir(), 'queue.log'), undefined, { restorable: false });
  const taskRunner = new TaskRunner({
    configPath,
    agents: config.agents,
    personaDir: config.director.persona_dir,
    defaultTimeoutMs: config.task.default_timeout_ms,
  });
  async function handleDirectorDynamicToolCall(
    call: DirectorDynamicToolCall & { sourceSessionId: string | null; workspace: string },
  ): Promise<DirectorDynamicToolResult> {
    return handlePersonaDynamicToolCall(call, {
      createTask,
      listTasks,
      getTask,
      runTask: (input) => taskRunner.runTask(input),
      createCronJob,
      listCronJobs,
      deleteCronJob,
      toggleCronJob,
    });
  }
  const director = new SessionBridge({
    agents: config.agents,
    agentsProvider: getFreshAgents,
    config: config.director,
    label: 'main',
    isMain: true,
    dynamicToolHandler: handleDirectorDynamicToolCall,
  });
  const isTestMode = process.env.PERSONA_TEST === '1';
  let messaging: MessagingRouter;
  if (isTestMode) {
    console.warn('[shell] PERSONA_TEST=1: starting in test mode, feishu disabled');
    const stubClient: MessagingClient = {
      start() {},
      onMessage() {},
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
    messaging = new MessagingRouter(stubClient);
  } else {
    const feishu = createFeishuClient(config.feishu, {
      skipMentionChatIds: config.pool.parallel_chat_ids,
      mentionOnlyChatIds: config.pool.mention_only_chat_ids,
      attachmentDir: join(config.director.persona_dir, 'attachments'),
    });
    messaging = new MessagingRouter(feishu);
  }
  const startTime = Date.now();
  const streamingReplies = new Map<string, StreamingReplyHandle>();
  const systemStreamingReplies = new Map<string, StreamingReplyHandle>();
  const streamCardToCorrelationId = new Map<string, string>();
  const streamSourceToCorrelationId = new Map<string, string>();
  const systemCardToMessageId = new Map<string, string>();
  const systemSourceMessageIds = new Set<string>();
  const cancelledSystemMessageIds = new Set<string>();
  const streamCancelAction = 'persona_stream_cancel';

  async function startStreamingReplyFor(correlationId: string, messageId: string): Promise<void> {
    if (!messaging.startStreamingReply) return;
    const head = queue.peek();
    if (!head || head.correlationId !== correlationId) return;
    if (head.cancelled) return;
    if (queue.isDispatching(correlationId)) return;
    if (streamingReplies.has(correlationId)) return;
    const handle = await messaging.startStreamingReply(messageId);
    if (handle) {
      streamingReplies.set(correlationId, handle);
      streamSourceToCorrelationId.set(messageId, correlationId);
      const cardMessageId = handle.getMessageId?.();
      if (cardMessageId) streamCardToCorrelationId.set(cardMessageId, correlationId);
    }
  }

  async function startStreamingReplyForHead(): Promise<void> {
    const item = queue.peek();
    if (!item) return;
    await startStreamingReplyFor(item.correlationId, item.messageId);
  }

  function appendStreamingReply(text: string): void {
    const item = queue.peek();
    if (!item) return;
    streamingReplies.get(item.correlationId)?.append(text);
  }

  function showToolCallInStreamingReply(toolName?: string): void {
    const item = queue.peek();
    if (!item) return;
    streamingReplies.get(item.correlationId)?.showToolCall?.(toolName);
  }

  async function finishStreamingReply(correlationId: string, text: string): Promise<boolean> {
    const handle = streamingReplies.get(correlationId);
    if (!handle) return false;
    streamingReplies.delete(correlationId);
    for (const [sourceMessageId, sourceCorrelationId] of streamSourceToCorrelationId.entries()) {
      if (sourceCorrelationId === correlationId) streamSourceToCorrelationId.delete(sourceMessageId);
    }
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) streamCardToCorrelationId.delete(cardMessageId);
    await handle.final(text);
    return true;
  }

  async function abortStreamingReply(correlationId: string, text?: string): Promise<void> {
    const handle = streamingReplies.get(correlationId);
    if (!handle) return;
    streamingReplies.delete(correlationId);
    for (const [sourceMessageId, sourceCorrelationId] of streamSourceToCorrelationId.entries()) {
      if (sourceCorrelationId === correlationId) streamSourceToCorrelationId.delete(sourceMessageId);
    }
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) streamCardToCorrelationId.delete(cardMessageId);
    await handle.abort(text).catch((err) => {
      log.debug(`[shell] Streaming reply abort failed: ${(err as Error).message}`);
    });
  }

  function abortStreamingReplies(items: Array<{ correlationId: string }>, text?: string): void {
    for (const item of items) {
      void abortStreamingReply(item.correlationId, text);
    }
  }

  async function startSystemStreamingReply(messageId: string): Promise<void> {
    if (!messaging.startStreamingReply || systemStreamingReplies.has(messageId)) return;
    const handle = await messaging.startStreamingReply(messageId);
    if (handle) {
      systemStreamingReplies.set(messageId, handle);
      systemSourceMessageIds.add(messageId);
      const cardMessageId = handle.getMessageId?.();
      if (cardMessageId) systemCardToMessageId.set(cardMessageId, messageId);
    }
  }

  function appendSystemStreamingReply(messageId: string, text: string): void {
    systemStreamingReplies.get(messageId)?.append(text);
  }

  function showSystemToolCall(messageId: string, toolName?: string): void {
    systemStreamingReplies.get(messageId)?.showToolCall?.(toolName);
  }

  async function finishSystemStreamingReply(messageId: string, text: string): Promise<boolean> {
    const handle = systemStreamingReplies.get(messageId);
    if (!handle) return false;
    systemStreamingReplies.delete(messageId);
    systemSourceMessageIds.delete(messageId);
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) systemCardToMessageId.delete(cardMessageId);
    await handle.final(text);
    return true;
  }

  async function abortSystemStreamingReply(messageId: string, text?: string): Promise<void> {
    const handle = systemStreamingReplies.get(messageId);
    if (!handle) return;
    systemStreamingReplies.delete(messageId);
    systemSourceMessageIds.delete(messageId);
    const cardMessageId = handle.getMessageId?.();
    if (cardMessageId) systemCardToMessageId.delete(cardMessageId);
    await handle.abort(text).catch((err) => {
      log.debug(`[shell] System streaming reply abort failed: ${(err as Error).message}`);
    });
  }

  async function cancelStreamingReplyByCard(action: CardAction): Promise<boolean> {
    const correlationId = streamCardToCorrelationId.get(action.messageId)
      ?? (action.sourceMessageId ? streamSourceToCorrelationId.get(action.sourceMessageId) : undefined);
    if (correlationId) {
      const cancelled = queue.cancel(correlationId);
      await abortStreamingReply(correlationId, '已取消');
      if (!cancelled) return false;
      console.log(`[shell] Feishu card cancel: cancelling ${cancelled.messageId} (cid=${correlationId})`);
      await director.interrupt();
      return true;
    }

    const systemMessageId = systemCardToMessageId.get(action.messageId)
      ?? (action.sourceMessageId && systemSourceMessageIds.has(action.sourceMessageId) ? action.sourceMessageId : undefined);
    if (systemMessageId) {
      cancelledSystemMessageIds.add(systemMessageId);
      await abortSystemStreamingReply(systemMessageId, '已取消');
      console.log(`[shell] Feishu card cancel: cancelling system reply ${systemMessageId}`);
      await director.interrupt();
      return true;
    }

    return false;
  }

  // --- In-memory metrics collector ---
  const metrics: MetricsCollector = {
    recentMessages: [],
    recentErrors: [],
    today: { date: '', messagesProcessed: 0, totalResponseMs: 0, totalCostUsd: 0 },

    addMessage(msg) {
      this.recentMessages.push(msg);
      if (this.recentMessages.length > 30) this.recentMessages.shift();
    },

    addError(message: string) {
      this.recentErrors.push({ message, timestamp: Date.now() });
      if (this.recentErrors.length > 20) this.recentErrors.shift();
    },

    getToday() {
      const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      if (this.today.date !== todayStr) {
        this.today = { date: todayStr, messagesProcessed: 0, totalResponseMs: 0, totalCostUsd: 0 };
      }
      return this.today;
    },
  };

  const restoredQueueCount = queue.restoreFromState();
  if (restoredQueueCount > 0) {
    console.log(`[shell] Restored ${restoredQueueCount} queued message(s) from state`);
  }

  const restoredDirector = director.restoreState();
  if (restoredDirector) {
    const flushAgoSec = Math.floor((Date.now() - restoredDirector.lastFlushAt) / 1000);
    console.log(
      `[shell] Restored director state: lastFlushAt=${flushAgoSec}s ago, lastInputTokens=${restoredDirector.lastInputTokens}, contextTokens=${restoredDirector.contextTokens ?? 0}`
    );
  }

  // DIRECTOR_LABEL is NOT in this config — it's injected via process env by each Director's spawn.
  // PERSONA_TEST shells must not overwrite the production ~/.persona/.mcp.json.
  const mcpConfigPath = writeShellMcpConfig(config, join(import.meta.dirname, 'task', 'task-mcp-server.ts'));
  if (mcpConfigPath) {
    console.log(`[shell] Wrote MCP config: ${mcpConfigPath}`);
  } else {
    console.warn('[shell] Skipped MCP config write for this process');
  }

  // Start director process
  const freshStart = await director.start();

  // Bootstrap: send initial message to trigger session creation and load context.
  // Claude CLI in stream-json mode doesn't create a session until it receives input.
  // Without this, Director sits idle with no session after restart.
  // Skip on reconnect — the Claude process already has context, sending bootstrap again wastes tokens.
  // Must await to prevent subsequent user messages from being merged into the bootstrap turn.
  if (freshStart) {
    await director.bootstrap();
  }

  // AgentRuntimePool for multi-group chat support
  const pool = new AgentRuntimePool(director, config.pool, config.agents, config.director, messaging, configPath, handleDirectorDynamicToolCall);

  // New domain components (transition: wrapping AgentRuntimePool)
  const workspaceRegistry = new WorkspaceRegistry();
  const sessionManager = new SessionManager(pool, workspaceRegistry);

  // Register main workspace + set its default session
  workspaceRegistry.getOrCreate('main');
  const mainSessionId = director.getStatus().sessionId;
  if (mainSessionId) workspaceRegistry.setDefaultSession('main', mainSessionId);
  {
    const wsDir = join(config.director.persona_dir, 'workspaces');
    const knownNames: string[] = ['main'];
    try {
      if (existsSync(wsDir)) {
        for (const name of readdirSync(wsDir)) {
          if (statSync(join(wsDir, name)).isDirectory()) knownNames.push(name);
        }
      }
    } catch (err) { console.warn(`[shell] Failed to scan workspaces dir ${wsDir}:`, err); }
    const migrated = workspaceRegistry.migrateFromLegacyKV(knownNames);
    if (migrated > 0) console.log(`[shell] Migrated ${migrated} workspace config(s) from legacy KV to workspaces table`);
  }

  function configCardWorkspaceFromMessage(msg: IncomingMessage): string {
    if (msg.chatType === 'group') {
      return sanitizeWorkspaceName(msg.workspaceName, msg.chatId.slice(0, 8));
    }
    return 'main';
  }

  function expandConfigCwd(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) throw new Error('cwd 不能为空');
    const expanded = trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
    const fullPath = resolve(expanded);
    const stat = statSync(fullPath);
    if (!stat.isDirectory()) throw new Error(`不是目录: ${fullPath}`);
    return fullPath;
  }

  function buildConfigCardState(workspaceName: string, notice?: string): ConfigCardState {
    const workspace = workspaceRegistry.getOrCreate(workspaceName);
    const sessions = listSessionsFromDb(workspaceName).map((row) => {
      const live = workspaceName === 'main' && director.getStatus().sessionId === row.session_id
        ? true
        : !!sessionManager.getSession(row.session_id);
      const liveEntry = sessionManager.getSession(row.session_id);
      const liveStatus = liveEntry?.bridge.getStatus();
      return {
        sessionId: row.session_id,
        name: row.session_name,
        agentName: liveStatus?.agentName ?? row.agent_name,
        agentType: liveStatus?.agentType ?? row.agent_type,
        model: liveStatus?.agentModel ?? row.model,
        alive: live,
        isDefault: workspace.default_session_id === row.session_id,
        lastMessageAt: row.last_message_at,
      };
    });
    const agents = Object.entries(getFreshAgents().providers).map(([name, provider]) => ({
      name,
      type: provider.type,
      model: provider.model,
    }));
    return {
      workspaceName,
      cwd: workspace.cwd,
      workspaceAgent: workspace.agent,
      defaultSessionId: workspace.default_session_id,
      sessions,
      agents,
      notice,
    };
  }

  function configCardFallbackText(state: ConfigCardState): string {
    const sessions = state.sessions.length > 0
      ? state.sessions.slice(0, 6).map((s) => `${s.isDefault ? '✅ ' : '- '}${s.name || s.sessionId} · ${s.agentName ?? 'agent:-'} · ${s.alive ? 'live' : 'sleep'}`).join('\n')
      : '暂无 session';
    return [
      `配置 · ${state.workspaceName}`,
      `cwd: ${state.cwd ?? '未配置'}`,
      `workspace agent: ${state.workspaceAgent ?? '默认'}`,
      `default session: ${state.defaultSessionId ?? '未设置'}`,
      '',
      sessions,
      '',
      '可用命令:',
      '/config cwd <path>',
      '/config agent <codex|claude>',
      '/config session <session_id>',
    ].join('\n');
  }

  async function sendConfigCard(chatId: string, workspaceName: string, opts?: { notice?: string; updateMessageId?: string; replyMessageId?: string }): Promise<void> {
    const state = buildConfigCardState(workspaceName, opts?.notice);
    const card = buildFeishuConfigCard(state);
    if (opts?.updateMessageId && messaging.updateInteractiveCard) {
      try {
        await messaging.updateInteractiveCard(opts.updateMessageId, card);
        return;
      } catch (err) {
        console.warn(`[shell] /config card update failed, falling back to send:`, err);
      }
    }
    if (messaging.sendInteractiveCard) {
      const sent = await messaging.sendInteractiveCard(chatId, card).catch((err) => {
        console.warn(`[shell] /config card send failed, falling back to text:`, err);
        return null;
      });
      if (sent) return;
    }
    const fallback = configCardFallbackText(state);
    if (opts?.replyMessageId) {
      await messaging.reply(opts.replyMessageId, fallback).catch(() => {});
      return;
    }
    await messaging.sendMessage(chatId, fallback).catch(() => {});
  }

  async function setConfigWorkspaceCwd(workspaceName: string, cwdInput: string): Promise<string> {
    const cwd = expandConfigCwd(cwdInput);
    workspaceRegistry.getOrCreate(workspaceName, { cwd });
    updateWorkspaceInDb(workspaceName, { cwd });
    return cwd;
  }

  async function setConfigSession(workspaceName: string, sessionId: string): Promise<void> {
    const record = getSessionRecord(sessionId);
    if (!record || record.workspace !== workspaceName || record.archived === 1) {
      throw new Error(`session 不属于当前 workspace 或已归档: ${sessionId}`);
    }
    sessionManager.setWorkspaceDefaultSession(sessionId);
  }

  async function createConfigSession(workspaceName: string, chatId: string, agentName?: string): Promise<string> {
    const targetAgent = agentName ? resolveAgentProvider(getFreshAgents(), 'director', agentName).name : undefined;
    const entry = workspaceName === 'main'
      ? null
      : await sessionManager.createNewSession(workspaceName, { feishuChatId: chatId, agentName: targetAgent });
    if (workspaceName === 'main') {
      if (targetAgent) await director.switchAgent(targetAgent);
      await director.resetSession();
      const sessionId = await director.waitForSessionId();
      if (!sessionId) throw new Error('main session was not initialized');
      workspaceRegistry.setDefaultSession('main', sessionId);
      return sessionId;
    }
    if (!entry?.sessionId) throw new Error('session was not initialized');
    sessionManager.setWorkspaceDefaultSession(entry.sessionId);
    return entry.sessionId;
  }

  async function switchConfigAgent(workspaceName: string, chatId: string, agentName: string): Promise<string> {
    const targetAgent = resolveAgentProvider(getFreshAgents(), 'director', agentName).name;
    if (workspaceName === 'main') {
      const ok = await director.switchAgent(targetAgent);
      if (!ok) throw new Error(`主会话切换到 ${targetAgent} 失败`);
      return targetAgent;
    }
    const workspace = workspaceRegistry.getOrCreate(workspaceName);
    let sessionId = workspace.default_session_id;
    if (!sessionId) {
      sessionId = await createConfigSession(workspaceName, chatId, targetAgent);
      return targetAgent;
    }
    let entry = sessionManager.getSession(sessionId);
    if (!entry) {
      const revived = await sessionManager.reviveSession(sessionId, { feishuChatId: chatId, agentName: targetAgent });
      entry = revived ?? null;
    }
    if (!entry?.sessionId) throw new Error(`default session 不可恢复: ${sessionId}`);
    const ok = await entry.bridge.switchAgent(targetAgent);
    if (!ok) throw new Error(`session 切换到 ${targetAgent} 失败`);
    sessionManager.setWorkspaceDefaultSession(entry.sessionId);
    return targetAgent;
  }


  async function handleConfigCardAction(action: CardAction): Promise<void> {
    if (config.feishu.master_id && action.senderOpenId !== config.feishu.master_id) return;
    const chatId = action.chatId;
    if (!chatId) return;
    const workspaceName = typeof action.value?.workspace === 'string'
      ? action.value.workspace
      : 'main';
    try {
      let notice = '';
      switch (action.action) {
        case 'persona_config_set_session': {
          const sessionId = typeof action.value?.sessionId === 'string' ? action.value.sessionId : '';
          if (!sessionId) throw new Error('missing sessionId');
          await setConfigSession(workspaceName, sessionId);
          notice = `已切换 default session: ${sessionId}`;
          break;
        }
        case 'persona_config_new_session': {
          const agentName = typeof action.value?.agent === 'string' ? action.value.agent : undefined;
          const sessionId = await createConfigSession(workspaceName, chatId, agentName);
          notice = `已新建并切换 session: ${sessionId}`;
          break;
        }
        case 'persona_config_switch_agent': {
          const agentName = typeof action.value?.agent === 'string' ? action.value.agent : '';
          if (!agentName) throw new Error('missing agent');
          const target = await switchConfigAgent(workspaceName, chatId, agentName);
          notice = `已切换当前 session agent: ${target}`;
          break;
        }
        case 'persona_config_cwd_help': {
          await messaging.sendMessage(chatId, `请发送：/config cwd <本地目录>\n例如：/config cwd /Users/ilike/github/jzlikewei/persona-shell\n\n说明：cwd 保存到当前群 workspace，对新 session 生效；如需当前 session 立即使用，请保存后重启或新建 session。`).catch(() => {});
          return;
        }
        case 'persona_config_refresh': {
          notice = '已刷新';
          break;
        }
        default:
          return;
      }
      await sendConfigCard(chatId, workspaceName, { notice, updateMessageId: action.messageId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await messaging.sendMessage(chatId, `配置操作失败：${msg}`).catch(() => {});
    }
  }

  messaging.onCardAction?.(async (action: CardAction) => {
    if (action.action.startsWith('persona_config_')) {
      await handleConfigCardAction(action);
      return;
    }
    if (action.action !== streamCancelAction) return;
    if (config.feishu.master_id && action.senderOpenId !== config.feishu.master_id) return;
    const cancelled = await cancelStreamingReplyByCard(action);
    if (cancelled) return;
    await sessionManager.cancelByCardAction(action);
  });

  // Restore pool entries from previous Shell session + clean up orphans
  await sessionManager.restoreEntries();
  await sessionManager.killUnknownOrphans();

  // Startup: clean up orphan tasks from previous crash/restart
  const orphanRecovered = taskRunner.cleanupOrphanTasks(
    (filter) => listTasks(filter) as Array<{ id: string; created_at: string; started_at: string | null; extra: TaskExtra | null; description: string }>,
    (id, data) => updateTask(id, data),
  );

  /** Resolve the target chatId and Director for a task callback.
   *
   * Delivery priority:
   *  1. source_session_id not archived → deliver to that session's director (revive if dead)
   *  2. source_session_id archived → deliver to workspace's default session
   *  3. workspace has no default session → deliver to main director
   *  4. no workspace / no session → deliver to main director
   *
   * Main director always has at least one session, so delivery never fails silently.
   */
  async function resolveTaskTarget(task: { source_session_id?: string | null; workspace?: string | null }): Promise<{
    chatId: string | null;
    isWeb: boolean;
    webLabel: string | null;
    notifyDirector: (taskId: string, success: boolean, msgId?: string) => Promise<void>;
  }> {
    const sourceSessionId = task.source_session_id?.trim() || null;
    const sourceRecord = sourceSessionId ? getSessionRecord(sourceSessionId) : null;
    const workspace = task.workspace?.trim() || sourceRecord?.workspace || 'main';
    const mainSessionId = director.getStatus().sessionId;

    // Step 1: source session not archived → try deliver to its director
    if (sourceSessionId && sourceRecord && sourceRecord.archived !== 1) {
      if (sourceSessionId === mainSessionId) {
        return mainTarget();
      }
      const entry = sessionManager.getRuntimeEntryBySessionId(sourceSessionId);
      if (entry) return poolTarget(entry);
      // Pool entry dead — revive the concrete source session first.  Falling
      // back to workspace default would make callbacks appear in a different
      // Web session when multiple sessions exist in one workspace.
      const revived = await tryReviveSession(sourceSessionId);
      if (revived) return poolTarget(revived);
    }

    // Step 2: source session archived or missing → try workspace default session
    if (workspace !== 'main') {
      const defaultSessionId = sessionManager.resolveDefaultSession(workspace);
      if (defaultSessionId && defaultSessionId === mainSessionId) {
        return mainTarget();
      }
      if (defaultSessionId) {
        const entry = sessionManager.getRuntimeEntryBySessionId(defaultSessionId);
        if (entry) return poolTarget(entry);
      }
      // No live default — try revive workspace
      const revived = await tryReviveWorkspace(workspace);
      if (revived) return poolTarget(revived);
    }

    // Step 3: fallback to main
    return mainTarget();
  }

  async function resolveCronTarget(job: { source_session_id?: string | null; workspace?: string | null }): Promise<{
    chatId: string | null;
    isWeb: boolean;
    webLabel: string | null;
    sessionId: string | null;
    notifyDirector: (taskId: string, success: boolean, msgId?: string) => Promise<void>;
    sendCronMessage: (msg: string) => Promise<void>;
  }> {
    const sourceSessionId = job.source_session_id?.trim() || null;
    const sourceRecord = sourceSessionId ? getSessionRecord(sourceSessionId) : null;
    const mainSessionId = director.getStatus().sessionId ?? null;

    if (sourceSessionId && (sourceSessionId === mainSessionId || (sourceRecord && sourceRecord.archived !== 1))) {
      const sourceTarget = await tryResolveSessionTarget(sourceSessionId);
      if (sourceTarget) return sourceTarget;
    }

    const workspace = job.workspace?.trim() || sourceRecord?.workspace || 'main';
    if (workspace !== 'main') {
      const defaultSessionId = sessionManager.resolveDefaultSession(workspace);
      if (defaultSessionId) {
        const defaultTarget = await tryResolveSessionTarget(defaultSessionId);
        if (defaultTarget) return defaultTarget;
      }
      const revived = await tryReviveWorkspace(workspace);
      if (revived) return cronPoolTarget(revived);
    }

    return cronMainTarget();
  }

  function mainTarget(): {
    chatId: string | null;
    isWeb: boolean;
    webLabel: null;
    notifyDirector: (taskId: string, success: boolean, msgId?: string) => Promise<void>;
  } {
    return {
      chatId: null,
      isWeb: false,
      webLabel: null,
      notifyDirector: async (taskId, success, msgId) => {
        if (msgId) await startSystemStreamingReply(msgId);
        await director.notifyTaskDone(taskId, success, msgId);
      },
    };
  }

  function cronMainTarget(): ReturnType<typeof mainTarget> & {
    sessionId: string | null;
    sendCronMessage: (msg: string) => Promise<void>;
  } {
    return {
      ...mainTarget(),
      sessionId: director.getStatus().sessionId ?? null,
      sendCronMessage: async (msg) => { await director.sendCronMessage(msg); },
    };
  }

  function poolTarget(entry: { bridge: SessionBridge; feishuChatId: string; routingKey: string; workspaceName: string }): {
    chatId: string | null;
    isWeb: boolean;
    webLabel: string | null;
    notifyDirector: (taskId: string, success: boolean, msgId?: string) => Promise<void>;
  } {
    const isWeb = entry.feishuChatId === 'web-console' || entry.routingKey.startsWith('web-');
    return {
      chatId: isWeb ? null : entry.feishuChatId,
      isWeb,
      webLabel: isWeb ? entry.workspaceName : null,
      notifyDirector: async (taskId, success, msgId) => {
        await entry.bridge.notifyTaskDone(taskId, success, msgId);
      },
    };
  }

  function cronPoolTarget(entry: { bridge: SessionBridge; feishuChatId: string; routingKey: string; workspaceName: string }): ReturnType<typeof poolTarget> & {
    sessionId: string | null;
    sendCronMessage: (msg: string) => Promise<void>;
  } {
    return {
      ...poolTarget(entry),
      sessionId: entry.bridge.getStatus().sessionId ?? null,
      sendCronMessage: async (msg) => { await entry.bridge.sendCronMessage(msg); },
    };
  }

  async function tryResolveSessionTarget(sessionId: string): Promise<ReturnType<typeof cronMainTarget> | ReturnType<typeof cronPoolTarget> | null> {
    if (sessionId === director.getStatus().sessionId) return cronMainTarget();
    const live = sessionManager.getRuntimeEntryBySessionId(sessionId);
    if (live) return cronPoolTarget(live);
    const revived = await tryReviveSession(sessionId);
    return revived ? cronPoolTarget(revived) : null;
  }

  async function tryReviveSession(sessionId: string): Promise<{ bridge: SessionBridge; feishuChatId: string; routingKey: string; workspaceName: string } | null> {
    try {
      const session = await sessionManager.reviveSession(sessionId, { feishuChatId: 'web-console' });
      const entry = session?.sessionId ? sessionManager.getRuntimeEntryBySessionId(session.sessionId) : null;
      if (entry) return entry;
    } catch (err) {
      console.warn(`[shell] Failed to revive session "${sessionId}" for callback/cron routing:`, err);
    }
    return null;
  }

  async function tryReviveWorkspace(workspace: string): Promise<{ bridge: SessionBridge; feishuChatId: string; routingKey: string; workspaceName: string } | null> {
    try {
      const session = await sessionManager.getOrCreateForWorkspace(workspace, { feishuChatId: 'web-console' });
      if (session?.bridge) {
        return {
          bridge: session.bridge,
          feishuChatId: 'web-console',
          routingKey: `web-workspace:${workspace}`,
          workspaceName: workspace,
        };
      }
    } catch (err) {
      console.warn(`[shell] Failed to revive workspace "${workspace}" for task callback:`, err);
    }
    return null;
  }

  function mergeTaskExtra(taskId: string, patch: TaskExtra): void {
    const current = getTask(taskId);
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined && value !== null),
    );
    updateTask(taskId, {
      extra: {
        ...(current?.extra ?? {}),
        ...cleanPatch,
      },
    });
  }

  function sanitizeWorkspaceName(raw: string | undefined, fallback: string): string {
    return (raw ?? fallback).replace(/[\/\\:*?"<>|]/g, '_').trim() || fallback;
  }

  function workspaceFeishuChatKey(workspace: string): string {
    return `workspace:feishu_chat_id:${workspace}`;
  }

  function isFeishuGroupChatId(chatId: string | null | undefined): chatId is string {
    return !!chatId && chatId !== 'web-console' && !chatId.startsWith('web-');
  }

  function rememberWorkspaceFeishuChat(workspace: string, chatId: string): void {
    if (!workspace || !isFeishuGroupChatId(chatId)) return;
    setState(workspaceFeishuChatKey(workspace), { chatId, updatedAt: localNow() });
  }

  function chatIdFromStateValue(value: unknown): string | null {
    if (typeof value === 'string' && isFeishuGroupChatId(value)) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const chatId = (value as Record<string, unknown>).chatId;
    return typeof chatId === 'string' && isFeishuGroupChatId(chatId) ? chatId : null;
  }

  function resolveWorkspaceFeishuChatId(workspace: string | null | undefined): string | null {
    const ws = workspace?.trim();
    if (!ws || ws === 'main') return null;

    const remembered = chatIdFromStateValue(getState<unknown>(workspaceFeishuChatKey(ws)));
    if (remembered) return remembered;

    const closed = getState<unknown>('pool:closed');
    if (Array.isArray(closed)) {
      for (const item of [...closed].reverse()) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        if (row.workspaceName !== ws) continue;
        const chatId = typeof row.feishuChatId === 'string' ? row.feishuChatId : null;
        if (isFeishuGroupChatId(chatId)) return chatId;
      }
    }

    return null;
  }

  function codexCallbackFromTask(task: { extra?: TaskExtra | null } | null | undefined): { threadId: string; cwd?: string } | null {
    const extra: TaskExtra = task?.extra && typeof task.extra === 'object' ? task.extra : {};
    const callback = extra.codex_callback && typeof extra.codex_callback === 'object'
      ? extra.codex_callback
      : null;
    if (!callback || callback.type !== 'codex_thread') return null;
    const threadId = typeof callback.thread_id === 'string' ? callback.thread_id.trim() : '';
    if (!threadId) return null;
    const cwd = typeof callback.cwd === 'string' && callback.cwd.trim() ? callback.cwd.trim() : undefined;
    return { threadId, ...(cwd ? { cwd } : {}) };
  }

  async function injectTaskCallbackIntoCodexThread(
    task: ReturnType<typeof getTask>,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const callback = codexCallbackFromTask(task);
    if (!callback || !task) return;
    const codexAgent = (() => {
      try {
        return resolveAgentProvider(getFreshAgents(), 'director', 'codex');
      } catch {
        return getFreshAgents().providers.codex;
      }
    })();
    if (!codexAgent?.command) {
      console.warn(`[shell] Codex callback for task ${task.id} skipped: codex provider is not configured`);
      return;
    }
    const resultLine = task.result_file ? `\n结果文件：${task.result_file}` : '';
    const statusLine = success
      ? `[TASK_DONE] persona-shell 后台任务 ${task.id} 已完成。`
      : `[TASK_FAILED] persona-shell 后台任务 ${task.id} 失败。错误：${error ?? task.error ?? 'unknown'}`;
    const text = [
      statusLine,
      `任务描述：${task.description}`,
      resultLine.trim(),
      '',
      '请立刻把这条消息当作用户的后台回调通知处理：先读取上面的任务结果文件，再给出简短结论；如果需要后续派发可以继续创建任务，但不要在本轮等待新任务完成。',
    ].filter(Boolean).join('\n');
    const injector = new CodexThreadInjector({
      logDir: join(getLogDir(), 'codex-thread-injector'),
      directorConfig: config.director,
      agent: codexAgent,
    });
    await injector.injectUserMessage({
      threadId: callback.threadId,
      cwd: callback.cwd,
      text,
      waitForCompletion: true,
      timeoutMs: 300_000,
    });
    console.log(`[shell] Notified Codex thread ${callback.threadId} about task ${task.id}`);
  }

  taskRunner.on('task-started', (taskId: string, spawnArgs: string[], pid: number) => {
    updateTask(taskId, {
      status: 'running',
      started_at: localNow(),
    });
    mergeTaskExtra(taskId, { spawnArgs, pid });
  });

  taskRunner.on('task-thread-started', (taskId: string, codexThreadId: string) => {
    mergeTaskExtra(taskId, { codex_thread_id: codexThreadId });
  });

  taskRunner.on('task-completed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'completed',
      completed_at: localNow(),
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
      result_file: result.resultFile ?? null,
    });
    if (result.codexThreadId) {
      mergeTaskExtra(result.taskId, { codex_thread_id: result.codexThreadId });
    }
    const task = getTask(result.taskId);
    const desc = task?.description ?? result.taskId;
    // Route notification to the Director/chat that created this task
    const target = await resolveTaskTarget(task ?? {});
    let notifyMsgId: string | undefined;
    const notifyMsg = `✅ 后台任务「${desc}」(${result.taskId}) 已完成，我来读下结果`;
    if (target.isWeb && target.webLabel) {
      // Web session — broadcast via WebSocket instead of messaging
      sessionManager.emit('web-alert', target.webLabel, notifyMsg);
    }
    const pushChatId = target.chatId ?? resolveWorkspaceFeishuChatId(task?.workspace);
    if (pushChatId) {
      try {
        notifyMsgId = (await messaging.sendMessage(pushChatId, notifyMsg)) ?? undefined;
      } catch (err) {
        console.warn('[shell] Failed to send task-completed notification:', err);
      }
    }
    const directorReplyMsgId = target.isWeb ? undefined : notifyMsgId;
    target.notifyDirector(result.taskId, true, directorReplyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task completion:', err);
    });
    injectTaskCallbackIntoCodexThread(task, true).catch((err) => {
      console.warn(`[shell] Failed to inject task ${result.taskId} callback into Codex thread:`, err);
    });
  });

  taskRunner.on('task-failed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'failed',
      completed_at: localNow(),
      error: result.error ?? 'unknown',
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
    });
    if (result.codexThreadId) {
      mergeTaskExtra(result.taskId, { codex_thread_id: result.codexThreadId });
    }

    const task = getTask(result.taskId);
    if (task && task.retry_count < task.max_retry && result.error !== 'cancelled') {
      updateTask(result.taskId, { retry_count: task.retry_count + 1, status: 'dispatched' });
      console.log(`[shell] Retrying task ${result.taskId} (attempt ${task.retry_count + 1}/${task.max_retry})`);
      taskRunner.runTask({ taskId: result.taskId, role: task.role, agent: task.agent ?? undefined, model: task.extra?.model, prompt: task.prompt, description: task.description, projectDir: task.extra?.project_dir });
      return;
    }

    // Route notification to the Director/chat that created this task
    const target = await resolveTaskTarget(task ?? {});
    let notifyMsgId: string | undefined;
    const taskDesc = task?.description ?? result.taskId;
    const isCancelled = result.error === 'cancelled';
    const failMsg = isCancelled
      ? `🚫 后台任务「${taskDesc}」(${result.taskId}) 已取消`
      : `❌ 后台任务「${taskDesc}」(${result.taskId}) 失败 — ${result.error}`;
    if (target.isWeb && target.webLabel) {
      // Web session — broadcast via WebSocket instead of messaging
      sessionManager.emit('web-alert', target.webLabel, failMsg);
    }
    const pushChatId = target.chatId ?? resolveWorkspaceFeishuChatId(task?.workspace);
    if (pushChatId) {
      try {
        notifyMsgId = (await messaging.sendMessage(pushChatId, failMsg)) ?? undefined;
      } catch (err) {
        console.warn('[shell] Failed to send task-failed notification:', err);
      }
    }
    const directorReplyMsgId = target.isWeb ? undefined : notifyMsgId;
    target.notifyDirector(result.taskId, false, directorReplyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task failure:', err);
    });
    injectTaskCallbackIntoCodexThread(task, false, result.error).catch((err) => {
      console.warn(`[shell] Failed to inject task ${result.taskId} failure into Codex thread:`, err);
    });
  });

  director.on('system-response', async (reply: string, replyToMessageId: string) => {
    if (cancelledSystemMessageIds.delete(replyToMessageId)) return;
    try {
      const streamed = await finishSystemStreamingReply(replyToMessageId, reply);
      if (!streamed) {
        await messaging.reply(replyToMessageId, reply);
      }
      log.debug(`[shell] System response replied to ${replyToMessageId}`);
    } catch (err) {
      console.warn('[shell] Failed to reply system response:', err);
    }
  });

  director.on('system-chunk', (text: string, replyToMessageId: string) => {
    appendSystemStreamingReply(replyToMessageId, text);
  });

  director.on('system-tool-call', (replyToMessageId: string, toolName?: string) => {
    showSystemToolCall(replyToMessageId, toolName);
  });

  director.on('system-stream-abort', (replyToMessageId: string, text?: string) => {
    void abortSystemStreamingReply(replyToMessageId, text);
  });


  // 启动 Web 管理控制台（含 Task API），返回 web 渠道的 MessagingClient
  // 启动前确保 V2 前端 dist 存在且不过时(缺则自动 vite build)
  await ensureWebV2Dist();
  const webClient = startConsole(director, queue, config, taskRunner, messaging, metrics, sessionManager, workspaceRegistry, getFreshConfig);
  messaging.addClient(webClient);

  async function sendQueuedAttachments(item: QueueItem): Promise<void> {
    const attachments = item.pendingAttachments ?? [];
    if (attachments.length === 0) return;

    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
    for (const attachment of attachments) {
      try {
        const isImage = imageExts.has(extname(attachment.path).toLowerCase());
        if (item.chatId === 'web-console' || attachment.targetChannel === 'web') {
          if (isImage) await webClient.uploadAndReplyImage(item.messageId, attachment.path);
          else await webClient.uploadAndReplyFile(item.messageId, attachment.path);
        } else {
          try {
            if (isImage) await messaging.uploadAndReplyImage(item.messageId, attachment.path);
            else await messaging.uploadAndReplyFile(item.messageId, attachment.path);
          } catch (err) {
            console.warn(`[shell] queued attachment reply failed, sending as new message instead: ${String(err)}`);
            if (isImage) await messaging.uploadAndSendImage(item.chatId, attachment.path);
            else await messaging.uploadAndSendFile(item.chatId, attachment.path);
          }
        }
        queue.logAction('ATTACHMENT_SENT', item.messageId, `cid=${item.correlationId} path=${attachment.path}`);
      } catch (err) {
        queue.logAction('ATTACHMENT_ERROR', item.messageId, `cid=${item.correlationId} path=${attachment.path} ${String(err)}`);
        console.error('[shell] queued attachment send failed:', err);
      }
    }
  }

  const scheduler = new Scheduler(
    config.scheduler,
    {
      listEnabledJobs: () => listCronJobs({ enabled: true }),
      executeSpawnRole: async (job) => {
        const workspace = job.workspace || 'main';
        const target = await resolveCronTarget(job);
        const task = createTask({
          type: 'cron',
          role: job.role,
          agent: job.agent ?? undefined,
          description: job.description,
          prompt: job.prompt,
          max_retry: job.max_retry,
          timeout_ms: job.timeout_ms ?? undefined,
          extra: { cronJobId: job.id },
          workspace,
          source_session_id: target.sessionId ?? undefined,
        });
        mergeTaskExtra(task.id, { parent_workspace: workspace, parent_session_id: target.sessionId });
        taskRunner.runTask({ taskId: task.id, role: task.role, agent: task.agent ?? undefined, model: task.extra?.model, prompt: task.prompt, description: task.description, timeoutMs: task.timeout_ms ?? undefined });
        return task.id;
      },
      isOverlapping: (jobId, _role) => {
        const active = listTasks({ status: 'running' });
        const dispatched = listTasks({ status: 'dispatched' });
        return [...active, ...dispatched].some(
          (t) => t.type === 'cron' && t.extra?.cronJobId === jobId,
        );
      },
      markJobRun: (jobId) => {
        updateCronJob(jobId, { last_run_at: localNow() });
      },
      executeDirectorMsg: async (job) => {
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const yesterday = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const msg = resolveCronMessage(config.director.persona_dir, job.message ?? '', { today, yesterday });

        const workspace = job.workspace || 'main';
        const target = await resolveCronTarget(job);
        if (workspace !== 'main' && target.sessionId !== job.source_session_id && !target.sessionId) {
          console.warn(`[scheduler] Cron job ${job.name} workspace=${workspace} has no session target, falling back to main`);
        }
        await target.sendCronMessage(msg);
      },
      executeShellAction: async (job) => {
        const actionName = job.action_name ?? '';

        if (isBashAction(actionName)) {
          const cmd = extractBashCommand(actionName);
          const maxRetry = Number.isFinite(job.max_retry) ? Math.max(0, job.max_retry) : 3;
          const timeoutMs = job.timeout_ms ?? undefined;
          console.log(`[scheduler] shell_action: bash exec for ${job.name}: ${cmd} (timeout=${timeoutMs ?? 'default'}ms retry=${maxRetry})`);

          let lastError: unknown = null;
          for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
            try {
              if (attempt > 0) {
                console.log(`[scheduler] bash retry ${attempt}/${maxRetry} for ${job.name}`);
              }
              const result = await runBashAction(cmd, { timeoutMs, logDir: join(getLogDir(), 'shell-action') });
              const outSnippet = result.stdout.trim().slice(0, 500);
              const errSnippet = result.stderr.trim().slice(0, 500);
              console.log(`[scheduler] bash ok for ${job.name} (log: ${result.logFile})` + (outSnippet ? `\n  stdout: ${outSnippet}` : '') + (errSnippet ? `\n  stderr: ${errSnippet}` : ''));
              return;
            } catch (err: unknown) {
              lastError = err;
              const e = err as { code?: number | string; stderr?: string; message?: string };
              const errSnippet = (e.stderr ?? e.message ?? '').trim().slice(0, 500);
              console.error(`[scheduler] bash FAILED for ${job.name} attempt=${attempt + 1}/${maxRetry + 1} (exit=${e.code ?? '?'})\n  stderr: ${errSnippet}`);
            }
          }
          const e = lastError as { code?: number | string; stderr?: string; message?: string };
          const errSnippet = (e?.stderr ?? e?.message ?? '').trim().slice(0, 500);
          throw new Error(`bash command failed after ${maxRetry + 1} attempts (exit=${e?.code ?? '?'}): ${errSnippet}`);
        }

        switch (actionName) {
          case 'check_feishu':
            console.log('[scheduler] shell_action: check_feishu (reserved)');
            break;
          case 'check_flush':
            console.log('[scheduler] shell_action: check_flush (reserved)');
            break;
          case 'flush':
            console.log('[scheduler] shell_action: flush — flushing all Directors');
            try {
              await sessionManager.flushAll();
              console.log('[scheduler] flush: pool Directors flushed, flushing main Director');
              await director.flush();
              console.log('[scheduler] flush completed');
              const lastChatId = messaging.getLastChatId();
              if (lastChatId) {
                await messaging.sendMessage(lastChatId, '🔄 定时 FLUSH 已完成，所有 Director 上下文已刷新').catch((e) => {
                  console.warn('[scheduler] flush notification failed:', e?.message ?? e);
                });
              }
            } catch (err) {
              console.error('[scheduler] flush failed:', err);
            }
            break;
          default:
            console.warn(`[scheduler] Unknown shell_action: ${job.action_name}`);
        }
      },
      notifyCronFired: (job) => {
        void (async () => {
          const target = await resolveCronTarget(job);
          const targetChatId = resolveWorkspaceFeishuChatId(job.workspace) ?? (target.isWeb ? null : target.chatId);

          if (!targetChatId) return;
          const actionType = job.action_type ?? 'spawn_role';
          const emoji = actionType === 'spawn_role' ? '🚀' : '⏰';
          const parts = [`${emoji} 定时任务「${job.name}」已触发`];
          parts.push(`📋 ${job.description}`);
          parts.push(`🔄 ${job.schedule} | ${actionType}`);
          if (actionType === 'director_msg' && job.message) {
            // Resolve file references (@prompts/...) and apply template variables
            const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const d = new Date(); d.setDate(d.getDate() - 1);
            const yesterday = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const rendered = resolveCronMessage(config.director.persona_dir, job.message, { today, yesterday });
            parts.push(`💬 ${rendered.slice(0, 100)}`);
          }
          messaging.sendMessage(targetChatId, parts.join('\n')).catch((err) => {
            console.warn('[shell] Failed to send cron notification:', err);
          });
        })().catch((err) => console.warn('[shell] Failed to resolve cron notification target:', err));
      },
    },
  );
  scheduler.start();

  // Notify Director about recovered orphan tasks from previous crash
  if (orphanRecovered.length > 0) {
    const summary = orphanRecovered.map(t => `- ${t.id}(${t.description}): ${t.status}`).join('\n');
    director.send(`[STARTUP] 回收了 ${orphanRecovered.length} 个上次崩溃遗留的孤儿任务:\n${summary}`).catch(() => {});
  }

  // Cron response forwarding — Director 处理 cron 消息后，转发响应到主聊天
  director.on('cron-response', (reply: string) => {
    const lastChatId = messaging.getLastChatId();
    if (lastChatId) {
      messaging.sendMessage(lastChatId, reply).catch((err) => {
        console.warn('[shell] Failed to forward cron response:', err);
      });
    }
  });

  // 内置 cron job：日报生成（迁移自 director.checkDailyReport）
  const existingDailyReport = listCronJobs().find((j) => j.name === 'daily-report');
  if (!existingDailyReport) {
    createCronJob({
      name: 'daily-report',
      role: 'system',
      description: '每日日报生成',
      prompt: '',
      schedule: 'daily 03:00',
      action_type: 'director_msg',
      message: '@prompts/daily-report.md',
    });
    console.log('[shell] Seeded built-in cron job: daily-report');
  }


  director.on('auto-flush-complete', () => {
    const lastChatId = messaging.getLastChatId();
    if (lastChatId) {
      messaging.sendMessage(lastChatId, '🔄 上下文已自动刷新').catch((err) => {
        console.warn('[shell] Failed to send auto-flush notification:', err);
      });
    }
  });

  // Clear orphaned queue items after flush drain — these items will never get
  // a response because the Director session is about to be destroyed.
  director.on('flush-drain-complete', () => {
    const orphaned = queue.clearAll();
    if (orphaned.length > 0) {
      abortStreamingReplies(orphaned, '上下文刷新中断了本轮回复');
      console.log(`[shell] Cleared ${orphaned.length} orphaned queue items after flush drain`);
    }
  });

  director.on('message-steered', (correlationId?: string) => {
    const item = correlationId ? queue.resolve(correlationId) : queue.resolveOldest();
    if (item) {
      queue.logAction('STEERED', item.messageId, `cid=${item.correlationId}`);
      void abortStreamingReply(item.correlationId, '已并入上一轮处理');
    }
  });

  // Clear orphaned queue items after Director crash — pendingTurns were reset
  // but MessageQueue still has items that would match the wrong response.
  director.on('queue-desync', () => {
    const orphans = queue.clearAll();
    if (orphans.length > 0) {
      abortStreamingReplies(orphans, 'Director 已重启，本轮回复已中断');
      console.warn(`[shell] Cleared ${orphans.length} orphaned queue items after crash`);
    }
  });

  director.on('stream-abort', () => {
    abortStreamingReplies(Array.from(streamingReplies.keys()).map((correlationId) => ({ correlationId })), 'Director 流式输出已中断');
  });

  director.on('alert', (message: string) => {
    metrics.addError(message);
    const lastChatId = messaging.getLastChatId();
    if (lastChatId) {
      messaging.sendMessage(lastChatId, message).catch((err) => {
        console.warn('[shell] Failed to send alert notification:', err);
      });
    }
  });

  /** 大群 one-shot 响应：spawn 一次性 Claude CLI 进程，回复后释放 */
  async function handleOneShot(prompt: string, messageId: string) {
    const ONESHOT_TIMEOUT = 60_000;
    const startedAt = Date.now();

    const { child } = spawnPersona({
      role: 'director',
      personaDir: config.director.persona_dir,
      agent: resolveAgentProvider(config.agents, 'director'),
      mode: 'background',
      mcpConfigPath: join(config.director.persona_dir, '.mcp.json'),
      prompt,
    });

    child.on('error', () => {}); // prevent unhandled error crash

    if (!child.pid || !child.stdout) {
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      await messaging.reply(messageId, '处理失败，请稍后重试').catch(() => {});
      return;
    }

    console.log(`[shell] One-shot spawned (pid=${child.pid})`);

    let responseText = '';
    let costUsd: number | undefined;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          if (event.result) responseText = event.result;
          if (event.cost_usd != null) costUsd = event.cost_usd;
          if (event.total_cost_usd != null) costUsd = event.total_cost_usd;
        }
      } catch { /* non-JSON line */ }
    });

    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
        resolve(true);
      }, ONESHOT_TIMEOUT);

      child.on('close', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    const elapsedMs = Date.now() - startedAt;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    if (timedOut || !responseText) {
      await messaging.reply(messageId, timedOut ? '处理超时，请稍后重试' : '未生成回复').catch(() => {});
    } else {
      const costStr = costUsd != null ? ` $${costUsd.toFixed(3)}` : '';
      await messaging.reply(messageId, `${responseText}\n\n(one-shot ${elapsedSec}s${costStr})`).catch(() => {});
    }

    metrics.addMessage({ direction: 'out', preview: (responseText || 'timeout').slice(0, 80), timestamp: Date.now(), responseSec: elapsedMs / 1000 });
    const today = metrics.getToday();
    today.messagesProcessed++;
    today.totalResponseMs += elapsedMs;
    if (costUsd) today.totalCostUsd += costUsd;

    console.log(`[shell] One-shot done ${messageId} (${elapsedSec}s${costUsd ? ` $${costUsd.toFixed(3)}` : ''} timeout=${timedOut})`);
  }

  // Messaging → queue → director
  messaging.onMessage(async (msg) => {
    const { text, messageId, chatId, chatType } = msg;
    // Log chat metadata
    const metaLog = chatType === 'group'
      ? `chatType=${chatType} workspaceName="${msg.workspaceName ?? ''}" members=${msg.memberCount ?? '?'} threadId=${msg.threadId ?? 'N/A'}`
      : `chatType=${chatType}`;
    log.debug(`[shell] Message meta: ${metaLog}`);

    // Pre-compute routingKey for slash commands (same logic as message routing below)
    const routingKey = (chatType === 'group')
      ? chatId                                   // 群聊: 按 chatId 路由（一个群一个 Director）
      : undefined;                               // 私聊: 默认 Director
    const messageWorkspaceName = chatType === 'group'
      ? sanitizeWorkspaceName(msg.workspaceName, chatId.slice(0, 8))
      : undefined;
    if (messageWorkspaceName) {
      rememberWorkspaceFeishuChat(messageWorkspaceName, chatId);
    }

    // Helper: resolve the target Director/queue for the current message context
    const getTargetEntry = () => routingKey ? sessionManager.runtimeGet(routingKey) : undefined;

    /** 本体检查：配置了 master_id 时，仅本体可执行危险命令 */
    const isMaster = !config.feishu.master_id || msg.senderOpenId === config.feishu.master_id;

    // /config — Feishu control card for current chat workspace. Workspace identity
    // stays tied to the group name; first phase only controls session / agent / cwd.
    const configMatch = text.trim().match(/^\/config(?:\s+(.*))?$/is);
    if (configMatch) {
      if (!isMaster) return;
      const workspaceName = configCardWorkspaceFromMessage(msg);
      const arg = (configMatch[1] ?? '').trim();
      try {
        if (!arg) {
          await sendConfigCard(chatId, workspaceName, { replyMessageId: messageId });
          return;
        }
        const cwdMatch = arg.match(/^cwd\s+(.+)$/is);
        if (cwdMatch) {
          const cwd = await setConfigWorkspaceCwd(workspaceName, cwdMatch[1]);
          await sendConfigCard(chatId, workspaceName, {
            notice: `cwd 已保存: ${cwd}。对新 session 生效；如需当前 session 使用新 cwd，请重启或新建 session。`,
            replyMessageId: messageId,
          });
          return;
        }
        const agentMatch = arg.match(/^agent\s+([\w-]+)$/i);
        if (agentMatch) {
          const target = await switchConfigAgent(workspaceName, chatId, agentMatch[1]);
          await sendConfigCard(chatId, workspaceName, { notice: `已切换当前 session agent: ${target}`, replyMessageId: messageId });
          return;
        }
        const sessionMatch = arg.match(/^session\s+([\w:-]+)$/i);
        if (sessionMatch) {
          await setConfigSession(workspaceName, sessionMatch[1]);
          await sendConfigCard(chatId, workspaceName, { notice: `已切换 default session: ${sessionMatch[1]}`, replyMessageId: messageId });
          return;
        }
        await messaging.reply(messageId, '用法：/config | /config cwd <path> | /config agent <codex|claude> | /config session <session_id>').catch(() => {});
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await messaging.reply(messageId, `配置失败：${errorMsg}`).catch(() => {});
      }
      return;
    }

    // /esc — cancel the oldest pending message (routes to correct Director)
    if (text.trim() === '/esc') {
      if (!isMaster) return;
      const poolEntry = getTargetEntry();
      if (poolEntry) {
        const cancelled = poolEntry.queue.cancelOldest();
        if (cancelled) {
          console.log(`[shell] /esc (group ${poolEntry.workspaceName}): cancelling ${cancelled.messageId}`);
          await sessionManager.abortStreamingReply(cancelled.correlationId, '已取消');
          await poolEntry.bridge.interrupt();
          await messaging.reply(messageId, `已取消: "${cancelled.text.slice(0, 50)}..."`).catch(() => {});
        } else {
          await messaging.reply(messageId, '队列为空，没有可取消的消息').catch(() => {});
        }
      } else {
        const cancelled = queue.cancelOldest();
        if (cancelled) {
          console.log(`[shell] /esc: cancelling message ${cancelled.messageId} (cid=${cancelled.correlationId})`);
          await abortStreamingReply(cancelled.correlationId, '已取消');
          await director.interrupt();
          await messaging.reply(messageId, `已取消: "${cancelled.text.slice(0, 50)}..."`).catch(() => {});
        } else {
          await messaging.reply(messageId, '队列为空，没有可取消的消息').catch(() => {});
        }
      }
      return;
    }

    // /flush — manually flush Director context (routes to correct Director)
    if (text.trim() === '/flush') {
      if (!isMaster) return;
      messaging.addReaction(messageId, 'Typing').catch(() => {});
      let poolEntry = getTargetEntry();
      if (routingKey && !poolEntry) {
        // Director not active — spin it up first so we can flush
        const workspaceName = messageWorkspaceName ?? sanitizeWorkspaceName(msg.workspaceName, chatId.slice(0, 8));
        const agentName = sessionManager.runtimeGetAgentName(routingKey)
          ?? config.agents.defaults.director ?? 'claude';
        const session = await sessionManager.getOrCreateForWorkspace(workspaceName, { workspaceName, feishuChatId: chatId, agentName });
        poolEntry = session.sessionId ? sessionManager.getRuntimeEntryBySessionId(session.sessionId) ?? undefined : getTargetEntry();
      }
      const targetDirector = poolEntry?.bridge ?? director;
      const label = poolEntry ? `group "${poolEntry.workspaceName}"` : 'main';
      const success = await targetDirector.flush();
      const flushMsg = success
        ? `FLUSH 完成，${label} 上下文已刷新`
        : `FLUSH 未能完成（${label}，超时或正在进行中），请稍后重试`;
      await messaging.reply(messageId, flushMsg).catch(async (err) => {
        console.warn(`[shell] /flush reply failed, falling back to sendMessage:`, err?.message ?? err);
        await messaging.sendMessage(chatId, flushMsg).catch((e) => {
          console.error(`[shell] /flush sendMessage also failed:`, e?.message ?? e);
        });
      });
      return;
    }

    // /clear — discard context without saving (routes to correct Director)
    if (text.trim() === '/clear') {
      if (!isMaster) return;
      messaging.addReaction(messageId, 'Typing').catch(() => {});
      const poolEntry = getTargetEntry();
      if (routingKey && !poolEntry) {
        await messaging.reply(messageId, '该群 Director 当前不活跃，无需 clear').catch(() => {});
        return;
      }
      const targetDirector = poolEntry?.bridge ?? director;
      const label = poolEntry ? `group "${poolEntry.workspaceName}"` : 'main';
      const success = await targetDirector.clearContext();
      if (success) {
        await messaging.reply(messageId, `CLEAR 完成，${label} 上下文已清空（未保存）`).catch(() => {});
      } else {
        await messaging.reply(messageId, `CLEAR 未能完成（${label}，正在进行中），请稍后重试`).catch(() => {});
      }
      return;
    }

    // /switch-agent | /start-with-* — switch current session Director backend
    const switchAgentMatch = text.trim().match(/^\/switch-agent\s+([\w-]+)$/i);
    const slashTargetAgent = text.trim() === '/start-with-codex'
      ? 'codex'
      : text.trim() === '/start-with-claude'
        ? 'claude'
        : switchAgentMatch?.[1]?.trim();
    if (slashTargetAgent) {
      if (!isMaster) return;
      if (routingKey && chatType === 'group' && (msg.memberCount ?? 0) > config.pool.small_group_threshold) {
        await messaging.reply(messageId, `当前群人数超过小群阈值（${config.pool.small_group_threshold}），请先调整阈值或使用小群`).catch(() => {});
        return;
      }

      let targetAgent: string;
      try {
        targetAgent = resolveAgentProvider(getFreshAgents(), 'director', slashTargetAgent).name;
      } catch (err) {
        await messaging.reply(messageId, `未知 agent: ${slashTargetAgent}`).catch(() => {});
        return;
      }

      messaging.addReaction(messageId, 'Typing').catch(() => {});

      if (routingKey && chatType === 'group') {
        const workspaceName = messageWorkspaceName ?? sanitizeWorkspaceName(msg.workspaceName, chatId.slice(0, 8));
        const currentAgent = sessionManager.runtimeGetAgentName(routingKey)
          ?? sessionManager.runtimeGet(routingKey)?.bridge.getAgentName()
          ?? config.agents.defaults.director
          ?? 'claude';
        if (currentAgent === targetAgent) {
          await messaging.reply(messageId, `群「${workspaceName}」已经是 ${targetAgent} 模式`).catch(() => {});
          return;
        }
        try {
          await sessionManager.setAgent(routingKey, { workspaceName, feishuChatId: chatId, agentName: targetAgent });
          await messaging.reply(messageId, `群「${workspaceName}」已切换为 ${targetAgent} 模式，已先 flush 保存上下文，并在新 agent 中恢复`).catch(() => {});
        } catch (err) {
          console.error('[shell] group switch-agent failed:', err);
          await messaging.reply(messageId, `群「${workspaceName}」切换到 ${targetAgent} 失败，请稍后重试`).catch(() => {});
        }
        return;
      }

      const currentAgent = director.getAgentName();
      if (currentAgent === targetAgent) {
        await messaging.reply(messageId, `主会话已经是 ${targetAgent} 模式`).catch(() => {});
        return;
      }

      const success = await director.switchAgent(targetAgent);
      if (success) {
        await messaging.reply(messageId, `主会话已切换为 ${targetAgent} 模式，已先 flush 保存上下文，并在新 agent 中恢复`).catch(() => {});
      } else {
        await messaging.reply(messageId, `主会话切换到 ${targetAgent} 失败，请稍后重试`).catch(() => {});
      }
      return;
    }

    // /persona <name> — switch persona role (e.g. philosopher, critic)
    const personaMatch = text.trim().match(/^\/persona\s+([\w-]+)$/i);
    if (personaMatch) {
      if (!isMaster) return;
      const personaName = personaMatch[1].toLowerCase();

      // Validate persona file exists
      const personaFile = join(config.director.persona_dir, 'personas', `${personaName}.md`);
      if (!existsSync(personaFile)) {
        await messaging.reply(messageId, `未知人格: ${personaName}，可用人格见 personas/ 目录`).catch(() => {});
        return;
      }

      messaging.addReaction(messageId, 'Typing').catch(() => {});

      if (routingKey && chatType === 'group') {
        const poolEntry = getTargetEntry();
        if (!poolEntry) {
          await messaging.reply(messageId, '该群 Director 当前不活跃，无法切换人格').catch(() => {});
          return;
        }
        const currentRole = poolEntry.bridge.getPersonaRole();
        if (currentRole === personaName) {
          await messaging.reply(messageId, `群「${poolEntry.workspaceName}」已经是「${personaName}」人格`).catch(() => {});
          return;
        }
        const success = await poolEntry.bridge.switchPersona(personaName);
        if (success) {
          await messaging.reply(messageId, `人格已切换为「${personaName}」`).catch(() => {});
        } else {
          await messaging.reply(messageId, `人格切换到「${personaName}」失败，请稍后重试`).catch(() => {});
        }
        return;
      }

      const currentRole = director.getPersonaRole();
      if (currentRole === personaName) {
        await messaging.reply(messageId, `主会话已经是「${personaName}」人格`).catch(() => {});
        return;
      }

      const success = await director.switchPersona(personaName);
      if (success) {
        await messaging.reply(messageId, `人格已切换为「${personaName}」`).catch(() => {});
      } else {
        await messaging.reply(messageId, `人格切换到「${personaName}」失败，请稍后重试`).catch(() => {});
      }
      return;
    }

    // /session-restart | /restart — restart current session's Director (routes to correct Director, preserves session)
    if (text.trim() === '/session-restart' || text.trim() === '/restart') {
      if (!isMaster) return;
      messaging.addReaction(messageId, 'Typing').catch(() => {});
      const poolEntry = getTargetEntry();
      const targetDirector = poolEntry?.bridge ?? director;
      const label = poolEntry ? `group "${poolEntry.workspaceName}"` : 'main';
      await messaging.reply(messageId, `正在重启 ${label} Director...`).catch(() => {});
      console.log(`[shell] /session-restart: restarting ${label} Director`);
      await targetDirector.restartProcess();
      await messaging.reply(messageId, `${label} Director 已重启`).catch(() => {});
      return;
    }

    // /new-session — drop current session and start fresh (routes to correct Director)
    if (text.trim() === '/new-session') {
      if (!isMaster) return;
      messaging.addReaction(messageId, 'Typing').catch(() => {});
      let label = 'main';
      if (routingKey && chatType === 'group') {
        const workspaceName = messageWorkspaceName ?? sanitizeWorkspaceName(msg.workspaceName, chatId.slice(0, 8));
        const agentName = sessionManager.runtimeGetAgentName(routingKey)
          ?? config.agents.defaults.director ?? 'claude';
        const poolEntry = await sessionManager.resetSession(routingKey, { workspaceName, feishuChatId: chatId, agentName });
        label = `group "${poolEntry.workspaceName}"`;
      } else {
        await director.resetSession();
        const newMainSessionId = director.getStatus().sessionId;
        if (newMainSessionId) workspaceRegistry.setDefaultSession('main', newMainSessionId);
      }
      await messaging.reply(messageId, `${label} session 已重置，新 session 已启动`).catch(() => {});
      console.log(`[shell] /new-session: cleared session for ${label}`);
      return;
    }

    // /shell-restart | /restart-shell — detach pool Directors + shutdown main Director + exit Shell (launchd will respawn)
    const shellRestart = parseShellRestartCommand(text);
    if (shellRestart) {
      if (!isMaster) return;
      const runningTasks = taskRunner.getRunningTasks();
      if (runningTasks.length > 0 && !shellRestart.force) {
        await messaging.reply(messageId, buildShellRestartBlockedMessage(runningTasks)).catch(() => {});
        console.warn(`[shell] /shell-restart refused: running tasks=${runningTasks.join(', ')}`);
        return;
      }

      if (runningTasks.length > 0) {
        console.warn(`[shell] /shell-restart --force: proceeding with running tasks=${runningTasks.join(', ')}`);
      }

      await messaging.reply(messageId, shellRestart.force ? 'Shell 正在强制重启...' : 'Shell 正在重启...').catch(() => {});
      console.log(`[shell] /shell-restart${shellRestart.force ? ' --force' : ''}: detaching pool Directors and exiting for launchd respawn`);
      await sessionManager.detachAll();
      await director.shutdown();
      process.exit(0);
    }

    if (text.trim() === '/help') {
      const lines = [
        '📖 可用命令:',
        '/switch-agent <agent> — 切换当前会话的 Director agent，并持久化恢复上下文',
        '/persona <name> — 切换人格角色（如 philosopher, critic 等）',
        '/start-with-codex — 将当前会话切到 Codex Director 模式',
        '/start-with-claude — 将当前会话切回 Claude Director 模式',
        '/flush — 保存上下文后刷新（checkpoint → 新 session）',
        '/clear — 清空上下文（不保存，直接重置）',
        '/esc — 取消队列中最早的消息',
        '/session-restart — 重启当前 Director（保留 session，加载新配置）',
        '/new-session — 丢弃当前 session，下次消息创建全新 session',
        '/shell-restart [--force] — 重启整个 Shell 进程（有后台任务时默认拒绝）',
        '/config — 打开当前群/会话配置卡片（session / agent / cwd）',
        '/config cwd <path> — 设置当前群 workspace 的工作目录',
        '/config agent <agent> — 切换当前/default session 的 Agent',
        '/config session <session_id> — 切换当前群 workspace 的 default session',
        '/help — 显示此帮助信息',
      ];
      await messaging.reply(messageId, lines.join('\n')).catch(() => {});
      return;
    }

    messaging.addReaction(messageId, 'Typing').catch((err) => {
      console.warn('[shell] Failed to add reaction:', err);
    });

    /** Format quoted text as blockquote prefix.
     *  @param maxLen — truncate to this length (0 = no truncation, for stateless one-shot) */
    const formatQuote = (raw: string, maxLen: number): string => {
      const truncated = maxLen > 0 && raw.length > maxLen
        ? raw.slice(0, maxLen) + '…(已截断)'
        : raw;
      const block = truncated.split('\n').map(l => `> ${l}`).join('\n');
      return `[引用上文]\n${block}\n\n`;
    };

    // 并行群（配置的特定 chat_id 或群名）→ 始终走 AgentRuntimePool，不受人数限制
    const isParallelChat = config.pool.parallel_chat_ids.includes(chatId)
      || config.pool.parallel_chat_ids.includes(msg.workspaceName ?? '');
    // 大群(>threshold 人，非并行群) → one-shot 响应，不走 Director
    if (chatType === 'group' && !isParallelChat && (msg.memberCount ?? 0) > config.pool.small_group_threshold) {
      // One-shot 无上下文，引用需要保留全文
      const quotePrefix = msg.quotedText ? formatQuote(msg.quotedText, 0) : '';
      const oneShotPrompt = `你在群聊「${msg.workspaceName || '未知群'}」中被 @ 提问。请简洁回复。\n\n${quotePrefix}${text}`;

      console.log(`[shell] Large group one-shot: ${text.slice(0, 50)}... (members=${msg.memberCount})`);
      metrics.addMessage({ direction: 'in', preview: text.slice(0, 80), timestamp: Date.now() });

      handleOneShot(oneShotPrompt, messageId).catch((err) => {
        console.error('[shell] One-shot error:', err);
        metrics.addError(`One-shot failed: ${String(err).slice(0, 200)}`);
        messaging.reply(messageId, '处理出错，请稍后重试').catch(() => {});
      });
      return;
    }

    // Prepend group chat label for Director context
    // Director 有上下文，引用截断到 quote_max_length
    const quotePrefix = msg.quotedText ? formatQuote(msg.quotedText, config.director.quote_max_length) : '';
    let directorText: string;
    const inputAttachments: DirectorInputAttachment[] | undefined = msg.attachments?.map((attachment) => ({
      type: attachment.type,
      path: attachment.filePath,
      name: attachment.fileName,
      detail: attachment.type === 'image' ? 'high' : undefined,
    }));

    if (chatType === 'group') {
      const senderTag = msg.senderName ? ` | ${msg.senderName}` : '';
      directorText = `[群聊: ${msg.workspaceName || '未知群'}${senderTag}] ${quotePrefix}${text}`;
    } else {
      directorText = `${quotePrefix}${text}`;
    }

    // Routing: 小群/话题群 → workspace default session, 私聊 → main workspace runtime
    // (routingKey was computed above, before slash command handling)
    if (routingKey) {
      log.debug(`[shell] Routing key: ${routingKey} (threadId=${msg.threadId ?? 'N/A'})`);
    }

    console.log(`[shell] Received message: ${directorText.slice(0, 50)}...`);
    metrics.addMessage({ direction: 'in', preview: text.slice(0, 80), timestamp: Date.now() });

    if (routingKey) {
      // 小群/话题群 → workspace default session
      try {
        const workspaceName = messageWorkspaceName ?? sanitizeWorkspaceName(msg.workspaceName, chatId.slice(0, 8));
        const session = await sessionManager.sendToWorkspaceDefaultSession(workspaceName, {
          workspaceName,
          feishuChatId: chatId,
          text: directorText,
          messageId,
          inputAttachments,
        });
        console.log(`[shell] Sent to workspace "${workspaceName}" default session ${session.sessionId || '(pending)'}`);
      } catch (err) {
        if (String(err).includes('flushing')) {
          await messaging.reply(messageId, '正在刷新上下文，请稍后重试').catch(() => {});
        } else {
          console.error(`[shell] workspace session send failed:`, err);
          metrics.addError(`Workspace session send failed: ${String(err).slice(0, 200)}`);
          const msg = String(err);
          const reply = msg.includes('active sessions but no default_session_id')
            ? '该工作区有多个 session，但尚未设置 default session。请先在 Web 控制台选择一个 session 设为 default。'
            : '消息发送失败，请稍后重试';
          await messaging.reply(messageId, reply).catch(() => {});
        }
      }
    } else {
      // 私聊 → main workspace runtime
      if (director.getStatus().pendingCount > 0) {
        try {
          director.promoteActiveTurnToUser();
          await director.send(directorText, { expectResponse: false, inputAttachments });
          queue.logAction('INSERT_INTO_ACTIVE_TURN', messageId, text.slice(0, 100));
          console.log(`[shell] Inserted message into active turn: ${messageId}`);
        } catch (err) {
          if (String(err).includes('flushing')) {
            await messaging.reply(messageId, '正在刷新上下文，请稍后重试').catch(() => {});
          } else {
            console.error(`[shell] insert failed:`, err);
            metrics.addError(`Insert failed: ${String(err).slice(0, 200)}`);
            await messaging.reply(messageId, '消息发送失败，请稍后重试').catch(() => {});
          }
        }
        return;
      }

      const correlationId = queue.enqueue({ text, messageId, chatId, inputAttachments });
      queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);
      try {
        await startStreamingReplyFor(correlationId, messageId);
        queue.markDispatching(correlationId);
        await director.send(directorText, { correlationId, inputAttachments });
        queue.markDispatched(correlationId);
        await startStreamingReplyFor(correlationId, messageId);
      } catch (err) {
        queue.markDispatched(correlationId);
        queue.resolve(correlationId);
        await abortStreamingReply(correlationId, '消息发送失败');
        if (String(err).includes('flushing')) {
          await messaging.reply(messageId, '正在刷新上下文，请稍后重试').catch(() => {});
        } else {
          console.error(`[shell] send failed, queue item cleaned:`, err);
          metrics.addError(`Send failed: ${String(err).slice(0, 200)}`);
          await messaging.reply(messageId, '消息发送失败，请稍后重试').catch(() => {});
        }
      }
    }
  });

  director.on('chunk', (text: string) => {
    appendStreamingReply(text);
  });

  director.on('tool-call', (toolName?: string) => {
    showToolCallInStreamingReply(toolName);
  });

  // Director response → resolve oldest → reply to user
  director.on('response', async (reply: string, durationMs?: number) => {
    const item = queue.resolveOldest();

    if (!item) {
      console.warn('[shell] Got director response but queue is empty');
      return;
    }

    // falling back to queue timestamp arithmetic if unavailable
    const elapsedMs = (typeof durationMs === 'number' && durationMs > 0)
      ? durationMs
      : Date.now() - item.timestamp;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const replyWithTiming = `${reply}\n\n(耗时 ${elapsedSec}s)`;

    // Track outgoing message and update daily stats
    metrics.addMessage({ direction: 'out', preview: reply.slice(0, 80), timestamp: Date.now(), responseSec: elapsedMs / 1000 });
    // Update daily stats
    const today = metrics.getToday();
    today.messagesProcessed++;
    today.totalResponseMs += elapsedMs;

    try {
      const streamed = await finishStreamingReply(item.correlationId, replyWithTiming);
      if (!streamed) {
        await messaging.reply(item.messageId, replyWithTiming);
      }
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s ${reply.slice(0, 100)}`);
      console.log(`[shell] Replied to ${item.messageId} (cid=${item.correlationId}, ${elapsedSec}s)`);
    } catch (err) {
      streamingReplies.delete(item.correlationId);
      queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
      metrics.addError(`Reply failed: ${String(err).slice(0, 200)}`);
      console.error(`[shell] reply failed, trying sendMessage as fallback:`, err);
      await messaging.sendMessage(item.chatId, replyWithTiming).catch((e) => {
        console.error(`[shell] sendMessage fallback also failed:`, e);
      });
    }
    await sendQueuedAttachments(item);
    await startStreamingReplyForHead();
  });

  let shuttingDown = false;

  director.on('close', async () => {
    if (shuttingDown) return;
    console.error('[shell] Director closed unexpectedly');
    metrics.addError('Director closed unexpectedly');
    await Promise.all(Array.from(streamingReplies.keys()).map((correlationId) => abortStreamingReply(correlationId, 'Director 已关闭，本轮回复已中断')));
    const lastChatId = messaging.getLastChatId();
    if (lastChatId) {
      try {
        await messaging.sendMessage(lastChatId, '🔴 Director 已关闭，Shell 即将退出');
      } catch { /* best-effort */ }
    }
    process.exit(1);
  });

  // Start messaging websocket
  messaging.start();

  console.log('[shell] Persona Shell started');

  // Startup notification — send to p2p chat (lastChatId only tracks p2p)
  const lastChatId = messaging.getLastChatId();
  if (lastChatId) {
    const exitReason = getState<{ reason: string; downSeconds?: number; at?: string }>('exitReason');
    deleteState('exitReason');

    let startupMsg = 'Shell 已重启 ✓';
    if (exitReason?.reason === 'feishu_disconnect') {
      startupMsg = `Shell 已重启 ✓（上次因消息通道断连 ${exitReason.downSeconds}s 自动重启）`;
    }

    setTimeout(async () => {
      try {
        await messaging.sendMessage(lastChatId, startupMsg);
        console.log('[shell] Startup notification sent');
      } catch (err) {
        console.warn('[shell] Failed to send startup notification:', err);
      }
    }, 3000);
  }

  // Graceful shutdown — detach Directors, orphan running tasks (they survive and get re-adopted on restart)
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shell] Shutting down (${signal}) — cleaning up...`);
    const runningTaskIds = taskRunner.getRunningTasks();
    if (runningTaskIds.length > 0) {
      console.log(`[shell] Orphaning ${runningTaskIds.length} running task(s): ${runningTaskIds.join(', ')} (will re-adopt on restart)`);
    }
    await Promise.allSettled([sessionManager.detachAll(), director.stop()]);
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[shell] Fatal error:', err);
  process.exit(1);
});

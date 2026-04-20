import { loadConfig, resolveAgentProvider } from './config.js';
import { SessionBridge } from './session-bridge.js';
import { DirectorPool } from './director-pool.js';
import { createFeishuClient } from './messaging/feishu.js';
import { MessagingRouter } from './messaging/messaging-router.js';
import type { IncomingMessage } from './messaging/messaging.js';
import { MessageQueue } from './queue.js';
import { startConsole, type MetricsCollector, type AttachmentBuffer } from './console.js';
import { TaskRunner, type TaskResult } from './task/task-runner.js';
import { spawnPersona } from './persona-process.js';
import { createInterface } from 'readline';
import { Scheduler } from './task/scheduler.js';
import { resolveCronMessage } from './prompt-loader.js';
import { updateTask, listTasks, createTask, getTask, getState, deleteState, listCronJobs, updateCronJob, createCronJob, initTaskStore, localNow } from './task/task-store.js';
import { writeFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { setLogLevel, log, initLogDir, getLogDir, cleanupOldLogs } from './logger.js';

// Prepend local timestamp (Asia/Shanghai) to all console output
for (const method of ['log', 'warn', 'error'] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(`[${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(',', '')}]`, ...args);
  };
}

async function main() {
  const config = loadConfig();
  setLogLevel(config.logging.level);
  initLogDir(config.director.persona_dir);
  initTaskStore(config.director.persona_dir);

  // 启动时清理过期日志（默认 7 天）
  const cleaned = cleanupOldLogs(7);
  if (cleaned > 0) log.info(`[startup] Cleaned ${cleaned} old log file(s)`);

  const queue = new MessageQueue(join(getLogDir(), 'queue.log'), undefined, { restorable: false });
  const director = new SessionBridge({ agents: config.agents, config: config.director, label: 'main', isMain: true });
  const feishu = createFeishuClient(config.feishu, {
    skipMentionChatIds: config.pool.parallel_chat_ids,
    attachmentDir: join(config.director.persona_dir, 'attachments'),
  });
  const messaging = new MessagingRouter(feishu);
  const startTime = Date.now();

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

  // 2.3/2.4: Restore queue state from disk
  const restoredQueueCount = queue.restoreFromState();
  if (restoredQueueCount > 0) {
    console.log(`[shell] Restored ${restoredQueueCount} queued message(s) from state`);
  }

  // 2.2/2.4: Restore director state from disk
  const restoredDirector = director.restoreState();
  if (restoredDirector) {
    const flushAgoSec = Math.floor((Date.now() - restoredDirector.lastFlushAt) / 1000);
    console.log(
      `[shell] Restored director state: lastFlushAt=${flushAgoSec}s ago, lastInputTokens=${restoredDirector.lastInputTokens}, contextTokens=${restoredDirector.contextTokens ?? 0}`
    );
  }

  // 7.0: Write .mcp.json BEFORE director.start() so Claude Code discovers task MCP server on spawn
  // DIRECTOR_LABEL is NOT in this config — it's injected via process env by each Director's spawn
  const mcpConfig = {
    mcpServers: {
      'persona-tasks': {
        command: 'bun',
        args: ['run', join(import.meta.dirname, 'task', 'task-mcp-server.ts')],
        env: {
          SHELL_PORT: String(config.console.port),
          ...(config.console.token ? { SHELL_TOKEN: config.console.token } : {}),
          no_proxy: '127.0.0.1,localhost',
        },
      },
    },
  };
  writeFileSync(join(config.director.persona_dir, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));

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

  // DirectorPool for multi-group chat support
  const pool = new DirectorPool(director, config.pool, config.agents, config.director, messaging);

  // Restore pool entries from previous Shell session + clean up orphans
  await pool.restoreEntries();
  await pool.killUnknownOrphans();

  // 7.3: Task runner — subprocess lifecycle management
  const taskRunner = new TaskRunner({
    agents: config.agents,
    personaDir: config.director.persona_dir,
    defaultTimeoutMs: config.task.default_timeout_ms,
  });

  /** Resolve the target chatId and Director for a task callback based on source_director.
   *  Falls back to main Director + last chatId if source is unknown. */
  async function resolveTaskTarget(task: { source_director?: string | null }): Promise<{
    chatId: string | null;
    isWeb: boolean;
    webLabel: string | null;
    notifyDirector: (taskId: string, success: boolean, msgId?: string) => Promise<void>;
  }> {
    const source = task.source_director;
    if (source && source !== 'main') {
      // Pool Director — look up or revive
      const poolChatId = pool.getChatIdByLabel(source);
      if (poolChatId) {
        // Check if this is a web session (chatId === 'web-console' is not a valid messaging target)
        const entry = pool.findByLabel(source);
        const isWeb = poolChatId === 'web-console' || (entry?.routingKey.startsWith('web-') ?? false);
        return {
          chatId: isWeb ? null : poolChatId,
          isWeb,
          webLabel: isWeb ? source : null,
          notifyDirector: (taskId, success, msgId) => pool.notifyTaskDone(source, taskId, success, msgId),
        };
      }
      // Pool entry lost (no routing context to revive) — fall through to main
      console.warn(`[shell] Task source_director=${source} not found in pool, falling back to main`);
    }
    // Main Director or unknown source
    return {
      chatId: messaging.getLastChatId(),
      isWeb: false,
      webLabel: null,
      notifyDirector: (taskId, success, msgId) => director.notifyTaskDone(taskId, success, msgId),
    };
  }

  // 7.3.4/7.3.5: Task lifecycle events → db update + Director notification + messaging notification
  taskRunner.on('task-started', (taskId: string, spawnArgs: string[]) => {
    updateTask(taskId, {
      status: 'running',
      started_at: localNow(),
      extra: { spawnArgs },
    });
  });

  taskRunner.on('task-completed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'completed',
      completed_at: localNow(),
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
      result_file: result.resultFile ?? null,
    });
    const task = getTask(result.taskId);
    const desc = task?.description ?? result.taskId;
    // Route notification to the Director/chat that created this task
    const target = await resolveTaskTarget(task ?? {});
    let notifyMsgId: string | undefined;
    const notifyMsg = `✅ 后台任务「${desc}」(${result.taskId}) 已完成，我来读下结果`;
    if (target.isWeb && target.webLabel) {
      // Web session — broadcast via WebSocket instead of messaging
      pool.emit('web-alert', target.webLabel, notifyMsg);
    } else if (target.chatId) {
      try {
        notifyMsgId = (await messaging.sendMessage(target.chatId, notifyMsg)) ?? undefined;
      } catch (err) {
        console.warn('[shell] Failed to send task-completed notification:', err);
      }
    }
    target.notifyDirector(result.taskId, true, notifyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task completion:', err);
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

    // 7.3.3: Retry if under max_retry — retry logic is here (Shell layer)
    const task = getTask(result.taskId);
    if (task && task.retry_count < task.max_retry && result.error !== 'cancelled') {
      updateTask(result.taskId, { retry_count: task.retry_count + 1, status: 'dispatched' });
      console.log(`[shell] Retrying task ${result.taskId} (attempt ${task.retry_count + 1}/${task.max_retry})`);
      taskRunner.runTask({ taskId: result.taskId, role: task.role, agent: task.agent ?? undefined, prompt: task.prompt, description: task.description, projectDir: (task.extra as Record<string, unknown>)?.project_dir as string | undefined });
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
      pool.emit('web-alert', target.webLabel, failMsg);
    } else if (target.chatId) {
      try {
        notifyMsgId = (await messaging.sendMessage(target.chatId, failMsg)) ?? undefined;
      } catch (err) {
        console.warn('[shell] Failed to send task-failed notification:', err);
      }
    }
    target.notifyDirector(result.taskId, false, notifyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task failure:', err);
    });
  });

  // 7.3.5: Director's response to task notifications — reply to the notification message
  director.on('system-response', async (reply: string, replyToMessageId: string) => {
    try {
      await messaging.reply(replyToMessageId, reply);
      log.debug(`[shell] System response replied to ${replyToMessageId}`);
    } catch (err) {
      console.warn('[shell] Failed to reply system response:', err);
    }
  });

  // Attachment compositor — buffer attachments per Director until response arrives
  const attachmentsBySource = new Map<string, string[]>();
  const attachmentBuffer: AttachmentBuffer = {
    push(source: string, filePath: string) {
      const list = attachmentsBySource.get(source) ?? [];
      list.push(filePath);
      attachmentsBySource.set(source, list);
      log.debug(`[shell] Compositor: buffered attachment ${filePath} for ${source} (${list.length} pending)`);
    },
    drain(source: string): string[] {
      const list = attachmentsBySource.get(source) ?? [];
      attachmentsBySource.delete(source);
      return list;
    },
    isProcessing(source: string): boolean {
      if (source === 'main') return queue.length > 0;
      const entry = pool.findByLabel(source);
      return entry ? entry.queue.length > 0 : false;
    },
  };

  // 启动 Web 管理控制台（含 Task API），返回 web 渠道的 MessagingClient
  pool.setAttachmentBuffer(attachmentBuffer);
  const webClient = startConsole(director, queue, config, taskRunner, messaging, metrics, attachmentBuffer, pool);
  messaging.addClient(webClient);

  // 7.4: Scheduler — interval-driven cron job automation
  const scheduler = new Scheduler(
    config.scheduler,
    {
      listEnabledJobs: () => listCronJobs({ enabled: true }),
      executeSpawnRole: async (job) => {
        const task = createTask({
          type: 'cron',
          role: job.role,
          agent: job.agent ?? undefined,
          description: job.description,
          prompt: job.prompt,
          extra: { cronJobId: job.id },
          source_director: job.source_director ?? undefined,
        });
        taskRunner.runTask({ taskId: task.id, role: task.role, agent: task.agent ?? undefined, prompt: task.prompt, description: task.description });
        return task.id;
      },
      isOverlapping: (jobId, _role) => {
        const active = listTasks({ status: 'running' });
        const dispatched = listTasks({ status: 'dispatched' });
        return [...active, ...dispatched].some(
          (t) => t.type === 'cron' && (t.extra as Record<string, unknown>)?.cronJobId === jobId,
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

        // Route to source Director if available
        const source = job.source_director;
        if (source && source !== 'main') {
          const entry = pool.findByLabel(source);
          if (entry) {
            await entry.bridge.sendCronMessage(msg);
            return;
          }
          // Pool entry lost — fall through to main
          console.warn(`[scheduler] Cron job ${job.name} source_director=${source} not found in pool, falling back to main`);
        }
        await director.sendCronMessage(msg);
      },
      executeShellAction: async (job) => {
        switch (job.action_name) {
          case 'check_feishu':
            console.log('[scheduler] shell_action: check_feishu (reserved)');
            break;
          case 'check_flush':
            console.log('[scheduler] shell_action: check_flush (reserved)');
            break;
          default:
            console.warn(`[scheduler] Unknown shell_action: ${job.action_name}`);
        }
      },
      notifyCronFired: (job) => {
        // Resolve target chatId: prefer source Director's chat, fallback to last active chat
        const source = job.source_director;
        let targetChatId: string | null = null;

        if (source && source !== 'main') {
          targetChatId = pool.getChatIdByLabel(source);
        }
        if (!targetChatId) {
          targetChatId = messaging.getLastChatId();
        }

        if (targetChatId) {
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
        }
      },
    },
  );
  scheduler.start();

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

  // 1.2: Auto-flush notification — notify last active chat when context is auto-flushed
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
      console.log(`[shell] Cleared ${orphaned.length} orphaned queue items after flush drain`);
    }
    // Compositor: discard main Director's buffered attachments — they'll never have a target message
    const discarded = attachmentBuffer.drain('main');
    if (discarded.length > 0) {
      console.log(`[shell] Compositor: discarding ${discarded.length} buffered attachment(s) after flush`);
    }
  });

  // Clear orphaned queue items after Director crash — pendingTurns were reset
  // but MessageQueue still has items that would match the wrong response.
  director.on('queue-desync', () => {
    const orphans = queue.clearAll();
    if (orphans.length > 0) {
      console.warn(`[shell] Cleared ${orphans.length} orphaned queue items after crash`);
    }
  });

  // 4.1: Alert notification — forward Director and system alerts to messaging
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
      ? `chatType=${chatType} groupName="${msg.groupName ?? ''}" members=${msg.memberCount ?? '?'} threadId=${msg.threadId ?? 'N/A'}`
      : `chatType=${chatType}`;
    log.debug(`[shell] Message meta: ${metaLog}`);

    // Pre-compute routingKey for slash commands (same logic as message routing below)
    const routingKey = (chatType === 'group')
      ? chatId                                   // 群聊: 按 chatId 路由（一个群一个 Director）
      : undefined;                               // 私聊: 默认 Director

    // Helper: resolve the target Director/queue for the current message context
    const getTargetEntry = () => routingKey ? pool.get(routingKey) : undefined;

    /** 本体检查：配置了 master_id 时，仅本体可执行危险命令 */
    const isMaster = !config.feishu.master_id || msg.senderOpenId === config.feishu.master_id;

    // /esc — cancel the oldest pending message (routes to correct Director)
    if (text.trim() === '/esc') {
      if (!isMaster) return;
      const poolEntry = getTargetEntry();
      if (poolEntry) {
        const cancelled = poolEntry.queue.cancelOldest();
        if (cancelled) {
          console.log(`[shell] /esc (group ${poolEntry.groupName}): cancelling ${cancelled.messageId}`);
          await poolEntry.bridge.interrupt();
          await messaging.reply(messageId, `已取消: "${cancelled.text.slice(0, 50)}..."`).catch(() => {});
        } else {
          await messaging.reply(messageId, '队列为空，没有可取消的消息').catch(() => {});
        }
      } else {
        const cancelled = queue.cancelOldest();
        if (cancelled) {
          console.log(`[shell] /esc: cancelling message ${cancelled.messageId} (cid=${cancelled.correlationId})`);
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
      const poolEntry = getTargetEntry();
      if (routingKey && !poolEntry) {
        await messaging.reply(messageId, '该群 Director 当前不活跃，无需 flush').catch(() => {});
        return;
      }
      const targetDirector = poolEntry?.bridge ?? director;
      const label = poolEntry ? `group "${poolEntry.groupName}"` : 'main';
      const success = await targetDirector.flush();
      if (success) {
        await messaging.reply(messageId, `FLUSH 完成，${label} 上下文已刷新`).catch(() => {});
      } else {
        await messaging.reply(messageId, `FLUSH 未能完成（${label}，超时或正在进行中），请稍后重试`).catch(() => {});
      }
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
      const label = poolEntry ? `group "${poolEntry.groupName}"` : 'main';
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
        targetAgent = resolveAgentProvider(config.agents, 'director', slashTargetAgent).name;
      } catch (err) {
        await messaging.reply(messageId, `未知 agent: ${slashTargetAgent}`).catch(() => {});
        return;
      }

      messaging.addReaction(messageId, 'Typing').catch(() => {});

      if (routingKey && chatType === 'group') {
        const groupName = msg.groupName ?? chatId.slice(0, 8);
        const currentAgent = pool.getDirectorAgentName(routingKey)
          ?? pool.get(routingKey)?.bridge.getDirectorAgentName()
          ?? config.agents.defaults.director
          ?? 'claude';
        if (currentAgent === targetAgent) {
          await messaging.reply(messageId, `群「${groupName}」已经是 ${targetAgent} 模式`).catch(() => {});
          return;
        }
        try {
          await pool.setDirectorAgent(routingKey, { groupName, feishuChatId: chatId, directorAgentName: targetAgent });
          await messaging.reply(messageId, `群「${groupName}」已切换为 ${targetAgent} 模式，已先 flush 保存上下文，并在新 agent 中恢复`).catch(() => {});
        } catch (err) {
          console.error('[shell] group switch-agent failed:', err);
          await messaging.reply(messageId, `群「${groupName}」切换到 ${targetAgent} 失败，请稍后重试`).catch(() => {});
        }
        return;
      }

      const currentAgent = director.getDirectorAgentName();
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
          await messaging.reply(messageId, `群「${poolEntry.groupName}」已经是「${personaName}」人格`).catch(() => {});
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
      const label = poolEntry ? `group "${poolEntry.groupName}"` : 'main';
      await messaging.reply(messageId, `正在重启 ${label} Director...`).catch(() => {});
      console.log(`[shell] /session-restart: restarting ${label} Director`);
      await targetDirector.restartProcess();
      await messaging.reply(messageId, `${label} Director 已重启`).catch(() => {});
      return;
    }

    // /shell-restart | /restart-shell — detach pool Directors + shutdown main Director + exit Shell (launchd will respawn)
    if (text.trim() === '/shell-restart' || text.trim() === '/restart-shell') {
      if (!isMaster) return;
      await messaging.reply(messageId, 'Shell 正在重启...').catch(() => {});
      console.log('[shell] /shell-restart: detaching pool Directors and exiting for launchd respawn');
      await pool.detachAll();
      await director.shutdown();
      process.exit(0);
    }

    // 1.4: /status — show Director status summary (routes to correct Director)
    if (text.trim() === '/status') {
      const poolEntry = getTargetEntry();
      if (poolEntry) {
        const s = poolEntry.bridge.getStatus();
        const label = poolEntry.groupName;
        const tokenLine = s.agentType === 'codex'
          ? `📊 Turn input: ${s.lastInputTokens.toLocaleString()}`
          : `📊 Context: ${s.lastInputTokens.toLocaleString()} / ${(s.contextWindow > 0 ? s.contextWindow : s.flushContextLimit).toLocaleString()}`;
        const lines = [
          `🟢 [${label}] Director: ${s.alive ? 'alive' : 'dead'} (pid: ${s.pid ?? 'N/A'})`,
          tokenLine,
          `📬 Pending: ${s.pendingCount} | Queue: ${poolEntry.queue.length}`,
          `🔄 Flushing: ${s.flushing ? 'yes' : 'no'}`,
          `⏱️ Session: ${s.sessionId?.slice(0, 8) ?? 'N/A'}`,
        ];
        await messaging.reply(messageId, lines.join('\n')).catch(() => {});
      } else {
        const s = director.getStatus();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const lastFlushAgo = Math.floor((Date.now() - s.lastFlushAt) / 1000);
        const tokenLine = s.agentType === 'codex'
          ? `📊 Turn input: ${s.lastInputTokens.toLocaleString()}`
          : `📊 Context: ${s.lastInputTokens.toLocaleString()} / ${(s.contextWindow > 0 ? s.contextWindow : s.flushContextLimit).toLocaleString()}`;
        const lines = [
          `🟢 Director: ${s.alive ? 'alive' : 'dead'} (pid: ${s.pid ?? 'N/A'})`,
          tokenLine,
          `📬 Pending: ${s.pendingCount} | Queue: ${queue.length}`,
          `🔄 Flushing: ${s.flushing ? 'yes' : 'no'} | Last flush: ${lastFlushAgo}s ago`,
          `⏱️ Uptime: ${uptime}s | Session: ${s.sessionId?.slice(0, 8) ?? 'N/A'}`,
        ];
        await messaging.reply(messageId, lines.join('\n')).catch(() => {});
      }
      return;
    }

    // 1.5: /help — list all available commands — global operation
    if (text.trim() === '/help') {
      const lines = [
        '📖 可用命令:',
        '/status — 查看 Director 状态摘要',
        '/switch-agent <agent> — 切换当前会话的 Director agent，并持久化恢复上下文',
        '/persona <name> — 切换人格角色（如 philosopher, critic 等）',
        '/start-with-codex — 将当前会话切到 Codex Director 模式',
        '/start-with-claude — 将当前会话切回 Claude Director 模式',
        '/flush — 保存上下文后刷新（checkpoint → 新 session）',
        '/clear — 清空上下文（不保存，直接重置）',
        '/esc — 取消队列中最早的消息',
        '/session-restart — 重启当前 Director（保留 session，加载新配置）',
        '/shell-restart — 重启整个 Shell 进程（代码更新生效）',
        '/help — 显示此帮助信息',
      ];
      await messaging.reply(messageId, lines.join('\n')).catch(() => {});
      return;
    }

    // 1.1: ACK — add emoji reaction to let user know message is received
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

    // 并行群（配置的特定 chat_id）→ 始终走 DirectorPool，不受人数限制
    const isParallelChat = config.pool.parallel_chat_ids.includes(chatId);
    // 大群(>threshold 人，非并行群) → one-shot 响应，不走 Director
    if (chatType === 'group' && !isParallelChat && (msg.memberCount ?? 0) > config.pool.small_group_threshold) {
      // One-shot 无上下文，引用需要保留全文
      const quotePrefix = msg.quotedText ? formatQuote(msg.quotedText, 0) : '';
      const oneShotPrompt = `你在群聊「${msg.groupName || '未知群'}」中被 @ 提问。请简洁回复。\n\n${quotePrefix}${text}`;

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
    if (chatType === 'group') {
      directorText = `[群聊: ${msg.groupName || '未知群'}] ${quotePrefix}${text}`;
    } else {
      directorText = `${quotePrefix}${text}`;
    }

    // Routing: 小群 → DirectorPool, 私聊 → 主 Director
    // (routingKey was computed above, before slash command handling)
    if (routingKey) {
      log.debug(`[shell] Routing key: ${routingKey} (threadId=${msg.threadId ?? 'N/A'})`);
    }

    console.log(`[shell] Received message: ${directorText.slice(0, 50)}...`);
    metrics.addMessage({ direction: 'in', preview: text.slice(0, 80), timestamp: Date.now() });

    if (routingKey) {
      // 小群/话题群 → DirectorPool
      try {
        const groupName = msg.groupName ?? chatId.slice(0, 8);
        const directorAgentName = pool.getDirectorAgentName(routingKey);
        const entry = await pool.getOrCreate(routingKey, { groupName, feishuChatId: chatId, directorAgentName });
        await pool.send(routingKey, directorText, messageId);
        console.log(`[shell] Sent to pool Director "${groupName}" (${routingKey.slice(0, 8)})`);
      } catch (err) {
        if (String(err).includes('flushing')) {
          await messaging.reply(messageId, '正在刷新上下文，请稍后重试').catch(() => {});
        } else {
          console.error(`[shell] pool send failed:`, err);
          metrics.addError(`Pool send failed: ${String(err).slice(0, 200)}`);
          await messaging.reply(messageId, '消息发送失败，请稍后重试').catch(() => {});
        }
      }
    } else {
      // 私聊 → 主 Director
      const correlationId = queue.enqueue({ text, messageId, chatId });
      queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);
      try {
        await director.send(directorText);
      } catch (err) {
        // 3.3: All send errors must clean up queue state to prevent orphaned items
        queue.resolve(correlationId);
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

  // Director response → resolve oldest → reply to user
  director.on('response', async (reply: string, durationMs?: number) => {
    const item = queue.resolveOldest();

    if (!item) {
      console.warn('[shell] Got director response but queue is empty');
      return;
    }

    // 4.3: Use duration_ms from Claude CLI result event (actual processing time),
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
      await messaging.reply(item.messageId, replyWithTiming);
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s ${reply.slice(0, 100)}`);
      console.log(`[shell] Replied to ${item.messageId} (cid=${item.correlationId}, ${elapsedSec}s)`);

      // Compositor: drain buffered attachments for main Director, reply to the same message
      const attachments = attachmentBuffer.drain('main');
      for (const filePath of attachments) {
        try {
          const ext = extname(filePath).toLowerCase();
          const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
          if (imageExts.has(ext)) {
            await messaging.uploadAndReplyImage(item.messageId, filePath);
          } else {
            await messaging.uploadAndReplyFile(item.messageId, filePath);
          }
          log.debug(`[shell] Compositor: sent attachment ${filePath} as reply to ${item.messageId}`);
        } catch (err) {
          console.error(`[shell] Compositor: failed to send attachment ${filePath}:`, err);
        }
      }
    } catch (err) {
      queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
      metrics.addError(`Reply failed: ${String(err).slice(0, 200)}`);
      console.error(`[shell] reply failed, trying sendMessage as fallback:`, err);
      await messaging.sendMessage(item.chatId, replyWithTiming).catch((e) => {
        console.error(`[shell] sendMessage fallback also failed:`, e);
      });
    }
  });

  director.on('close', async () => {
    console.error('[shell] Director closed unexpectedly');
    metrics.addError('Director closed unexpectedly');
    // 4.1: Notify before exit
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

  // Graceful shutdown — detach pool Directors (keep alive for reconnect), stop main Director
  process.on('SIGINT', async () => {
    console.log('[shell] Shutting down (SIGINT) — detaching pool Directors...');
    await Promise.allSettled([pool.detachAll(), director.stop()]);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[shell] Fatal error:', err);
  process.exit(1);
});

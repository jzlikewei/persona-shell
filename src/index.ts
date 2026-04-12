import { loadConfig } from './config.js';
import { Director } from './director.js';
import { createFeishuClient, type ChatMeta } from './feishu.js';
import { MessageQueue } from './queue.js';
import { startConsole, type MetricsCollector, type AttachmentBuffer } from './console.js';
import { TaskRunner, type TaskResult } from './task-runner.js';
import { Scheduler } from './scheduler.js';
import { updateTask, listTasks, createTask, getTask, getState, deleteState, listCronJobs, updateCronJob, createCronJob } from './task-store.js';
import { writeFileSync } from 'fs';
import { join, extname } from 'path';
import { setLogLevel, log } from './logger.js';

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
  const queue = new MessageQueue(config.logging.queue_log);
  const director = new Director(config.director);
  const feishu = createFeishuClient(config.feishu);
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
      `[shell] Restored director state: lastFlushAt=${flushAgoSec}s ago, lastInputTokens=${restoredDirector.lastInputTokens}`
    );
  }

  // 7.0: Write .mcp.json BEFORE director.start() so Claude Code discovers task MCP server on spawn
  const mcpConfig = {
    mcpServers: {
      'persona-tasks': {
        command: 'bun',
        args: ['run', join(import.meta.dirname, 'task-mcp-server.ts')],
        env: {
          SHELL_PORT: String(config.console.port),
          ...(config.console.token ? { SHELL_TOKEN: config.console.token } : {}),
        },
      },
    },
  };
  writeFileSync(join(config.director.persona_dir, '.mcp.json'), JSON.stringify(mcpConfig, null, 2));

  // Start director process
  await director.start();

  // Bootstrap: send initial message to trigger session creation and load context.
  // Claude CLI in stream-json mode doesn't create a session until it receives input.
  // Without this, Director sits idle with no session after restart.
  director.bootstrap();

  // 7.3: Task runner — subprocess lifecycle management
  const taskRunner = new TaskRunner({
    claudePath: config.director.claude_path,
    personaDir: config.director.persona_dir,
    defaultTimeoutMs: config.task.default_timeout_ms,
  });

  // 7.3.4/7.3.5: Task lifecycle events → db update + Director notification + feishu notification
  taskRunner.on('task-started', (taskId: string, spawnArgs: string[]) => {
    updateTask(taskId, {
      status: 'running',
      started_at: new Date().toISOString(),
      extra: { spawnArgs },
    });
  });

  taskRunner.on('task-completed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
      result_file: result.resultFile ?? null,
    });
    const task = getTask(result.taskId);
    const desc = task?.description ?? result.taskId;
    // Send feishu notification first, capture messageId for Director's reply
    const lastChatId = feishu.getLastChatId();
    let notifyMsgId: string | undefined;
    if (lastChatId) {
      notifyMsgId = (await feishu.sendMessage(lastChatId, `✅ 后台任务「${desc}」(${result.taskId}) 已完成，我来读下结果`)) ?? undefined;
    }
    director.notifyTaskDone(result.taskId, true, notifyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task completion:', err);
    });
  });

  taskRunner.on('task-failed', async (result: TaskResult) => {
    updateTask(result.taskId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: result.error ?? 'unknown',
      duration_ms: result.durationMs,
      cost_usd: result.costUsd ?? null,
    });

    // 7.3.3: Retry if under max_retry — retry logic is here (Shell layer)
    const task = getTask(result.taskId);
    if (task && task.retry_count < task.max_retry && result.error !== 'cancelled') {
      updateTask(result.taskId, { retry_count: task.retry_count + 1, status: 'dispatched' });
      console.log(`[shell] Retrying task ${result.taskId} (attempt ${task.retry_count + 1}/${task.max_retry})`);
      taskRunner.runTask({ taskId: result.taskId, role: task.role, prompt: task.prompt, description: task.description });
      return;
    }

    const lastChatId = feishu.getLastChatId();
    let notifyMsgId: string | undefined;
    if (lastChatId) {
      const desc = task?.description ?? result.taskId;
      const isCancelled = result.error === 'cancelled';
      const msg = isCancelled
        ? `🚫 后台任务「${desc}」(${result.taskId}) 已取消`
        : `❌ 后台任务「${desc}」(${result.taskId}) 失败 — ${result.error}`;
      notifyMsgId = (await feishu.sendMessage(lastChatId, msg)) ?? undefined;
    }
    director.notifyTaskDone(result.taskId, false, notifyMsgId).catch((err) => {
      console.warn('[shell] Failed to notify Director of task failure:', err);
    });
  });

  // 7.3.5: Director's response to task notifications — reply to the feishu notification message
  director.on('system-response', async (reply: string, replyToMessageId: string) => {
    try {
      await feishu.reply(replyToMessageId, reply);
      log.debug(`[shell] System response replied to ${replyToMessageId}`);
    } catch (err) {
      console.warn('[shell] Failed to reply system response:', err);
    }
  });

  // Attachment compositor — buffer attachments until pipe response arrives
  const pendingAttachments: string[] = [];
  const attachmentBuffer: AttachmentBuffer = {
    push(filePath: string) {
      pendingAttachments.push(filePath);
      log.debug(`[shell] Compositor: buffered attachment ${filePath} (${pendingAttachments.length} pending)`);
    },
    hasPending() {
      return queue.length > 0;
    },
  };

  // 启动 Web 管理控制台（含 Task API）
  startConsole(director, queue, config, taskRunner, feishu, metrics, attachmentBuffer);

  // 7.4: Scheduler — interval-driven cron job automation
  const scheduler = new Scheduler(
    config.scheduler,
    {
      listEnabledJobs: () => listCronJobs({ enabled: true }),
      executeSpawnRole: async (job) => {
        const task = createTask({
          type: 'cron',
          role: job.role,
          description: job.description,
          prompt: job.prompt,
          extra: { cronJobId: job.id },
        });
        taskRunner.runTask({ taskId: task.id, role: task.role, prompt: task.prompt, description: task.description });
        return task.id;
      },
      isOverlapping: (role) => {
        const active = listTasks({ role });
        return active.some((t) => t.type === 'cron' && (t.status === 'running' || t.status === 'dispatched'));
      },
      markJobRun: (jobId) => {
        updateCronJob(jobId, { last_run_at: new Date().toISOString() });
      },
      executeDirectorMsg: async (job) => {
        // 模板变量替换：{today} {yesterday}
        let msg = job.message ?? '';
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const yesterday = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        msg = msg.replace(/\{today\}/g, today).replace(/\{yesterday\}/g, yesterday);
        await director.sendSystemMessage(msg);
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
    },
  );
  scheduler.start();

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
      message: '[系统] 日期已变更为 {today}。请为 {yesterday} 撰写日报，保存到 daily/{yesterday}.md。同时更新 daily/state.md 的状态。',
    });
    console.log('[shell] Seeded built-in cron job: daily-report');
  }

  // 1.2: Auto-flush notification — notify last active chat when context is auto-flushed
  director.on('auto-flush-complete', () => {
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      feishu.sendMessage(lastChatId, '🔄 上下文已自动刷新').catch((err) => {
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
    // Compositor: discard any buffered attachments — they'll never have a target message
    if (pendingAttachments.length > 0) {
      console.log(`[shell] Compositor: discarding ${pendingAttachments.length} buffered attachment(s) after flush`);
      pendingAttachments.length = 0;
    }
  });

  // 4.1: Alert notification — forward Director and system alerts to feishu
  director.on('alert', (message: string) => {
    metrics.addError(message);
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      feishu.sendMessage(lastChatId, message).catch((err) => {
        console.warn('[shell] Failed to send alert notification:', err);
      });
    }
  });

  // Feishu message → queue → director
  feishu.onMessage(async (text, messageId, chatId, msgType, meta) => {
    // Log chat metadata
    const metaLog = meta.chatType === 'group'
      ? `chatType=${meta.chatType} chatName="${meta.chatName ?? ''}" members=${meta.memberCount ?? '?'}`
      : `chatType=${meta.chatType}`;
    log.debug(`[shell] Message meta: ${metaLog}`);

    // 1.3: Non-text message feedback
    if (msgType !== 'text') {
      console.log(`[shell] Non-text message type: ${msgType}`);
      await feishu.reply(messageId, `暂不支持 ${msgType} 类型消息，请发送文字消息`);
      return;
    }

    // /esc — cancel the oldest pending message
    if (text.trim() === '/esc') {
      const cancelled = queue.cancelOldest();
      if (cancelled) {
        console.log(`[shell] /esc: cancelling message ${cancelled.messageId} (cid=${cancelled.correlationId})`);
        await director.interrupt();
        await feishu.reply(messageId, `已取消: "${cancelled.text.slice(0, 50)}..."`);
      } else {
        await feishu.reply(messageId, '队列为空，没有可取消的消息');
      }
      return;
    }

    // /flush — manually flush Director context
    if (text.trim() === '/flush') {
      feishu.addReaction(messageId, 'Typing').catch(() => {});
      const success = await director.flush();
      if (success) {
        await feishu.reply(messageId, 'FLUSH 完成，上下文已刷新');
      } else {
        await feishu.reply(messageId, 'FLUSH 未能完成（超时或正在进行中），请稍后重试');
      }
      return;
    }

    // /restart — kill Director + restart Shell (launchd will respawn)
    if (text.trim() === '/restart') {
      await feishu.reply(messageId, 'Shell 正在重启...');
      console.log('[shell] /restart: killing Director and exiting for launchd respawn');
      const pid = director.getStatus().pid;
      if (pid) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
      }
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // 1.4: /status — show Director status summary
    if (text.trim() === '/status') {
      const s = director.getStatus();
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const lastFlushAgo = Math.floor((Date.now() - s.lastFlushAt) / 1000);
      const contextLimit = s.contextWindow > 0 ? s.contextWindow : s.flushContextLimit;
      const lines = [
        `🟢 Director: ${s.alive ? 'alive' : 'dead'} (pid: ${s.pid ?? 'N/A'})`,
        `📊 Tokens: ${s.lastInputTokens.toLocaleString()} / ${contextLimit.toLocaleString()}`,
        `📬 Pending: ${s.pendingCount} | Queue: ${queue.length}`,
        `🔄 Flushing: ${s.flushing ? 'yes' : 'no'} | Last flush: ${lastFlushAgo}s ago`,
        `⏱️ Uptime: ${uptime}s | Session: ${s.sessionId?.slice(0, 8) ?? 'N/A'}`,
      ];
      await feishu.reply(messageId, lines.join('\n'));
      return;
    }

    // 1.5: /help — list all available commands
    if (text.trim() === '/help') {
      const lines = [
        '📖 可用命令:',
        '/status — 查看 Director 状态摘要',
        '/flush — 手动刷新上下文',
        '/esc — 取消队列中最早的消息',
        '/restart — 重启 Shell 进程',
        '/help — 显示此帮助信息',
      ];
      await feishu.reply(messageId, lines.join('\n'));
      return;
    }

    // 1.1: ACK — add emoji reaction to let user know message is received
    feishu.addReaction(messageId, 'Typing').catch((err) => {
      console.warn('[shell] Failed to add reaction:', err);
    });

    // Prepend group chat label for Director context
    const directorText = meta.chatType === 'group'
      ? `[群聊: ${meta.chatName || '未知群'}] ${text}`
      : text;

    console.log(`[shell] Received message: ${directorText.slice(0, 50)}...`);
    metrics.addMessage({ direction: 'in', preview: text.slice(0, 80), timestamp: Date.now() });
    const correlationId = queue.enqueue({ text, messageId, chatId });
    queue.logAction('SEND_TO_DIRECTOR', messageId, `cid=${correlationId} ${text.slice(0, 100)}`);
    try {
      await director.send(directorText);
    } catch (err) {
      // 3.3: All send errors must clean up queue state to prevent orphaned items
      queue.resolve(correlationId);
      if (String(err).includes('flushing')) {
        await feishu.reply(messageId, '正在刷新上下文，请稍后重试');
      } else {
        console.error(`[shell] send failed, queue item cleaned:`, err);
        metrics.addError(`Send failed: ${String(err).slice(0, 200)}`);
        await feishu.reply(messageId, '消息发送失败，请稍后重试').catch(() => {});
      }
    }
  });

  // Director response → resolve oldest → reply feishu
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
    // Update the corresponding 'in' message with responseSec
    const inMsg = [...metrics.recentMessages].reverse().find(
      (m) => m.direction === 'in' && !m.responseSec
    );
    if (inMsg) inMsg.responseSec = elapsedMs / 1000;
    // Update daily stats
    const today = metrics.getToday();
    today.messagesProcessed++;
    today.totalResponseMs += elapsedMs;

    try {
      await feishu.reply(item.messageId, replyWithTiming);
      queue.logAction('REPLY_SENT', item.messageId, `cid=${item.correlationId} elapsed=${elapsedSec}s ${reply.slice(0, 100)}`);
      console.log(`[shell] Replied to ${item.messageId} (cid=${item.correlationId}, ${elapsedSec}s)`);

      // Compositor: drain buffered attachments, reply to the same message
      const attachments = pendingAttachments.splice(0);
      for (const filePath of attachments) {
        try {
          const ext = extname(filePath).toLowerCase();
          const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico']);
          if (imageExts.has(ext)) {
            await feishu.uploadAndReplyImage(item.messageId, filePath);
          } else {
            await feishu.uploadAndReplyFile(item.messageId, filePath);
          }
          log.debug(`[shell] Compositor: sent attachment ${filePath} as reply to ${item.messageId}`);
        } catch (err) {
          console.error(`[shell] Compositor: failed to send attachment ${filePath}:`, err);
        }
      }
    } catch (err) {
      queue.logAction('ERROR', item.messageId, `cid=${item.correlationId} ${String(err)}`);
      metrics.addError(`Reply failed: ${String(err).slice(0, 200)}`);
      console.error(`[shell] Failed to reply:`, err);
    }
  });

  director.on('close', async () => {
    console.error('[shell] Director closed unexpectedly');
    metrics.addError('Director closed unexpectedly');
    // 4.1: Notify before exit
    const lastChatId = feishu.getLastChatId();
    if (lastChatId) {
      try {
        await feishu.sendMessage(lastChatId, '🔴 Director 已关闭，Shell 即将退出');
      } catch { /* best-effort */ }
    }
    process.exit(1);
  });

  // Start feishu websocket
  feishu.start();

  console.log('[shell] Persona Shell started');

  // Startup notification — check exit reason and send appropriate message
  const lastChatId = feishu.getLastChatId();
  if (lastChatId) {
    const exitReason = getState<{ reason: string; downSeconds?: number; at?: string }>('exitReason');
    deleteState('exitReason');

    let startupMsg = 'Shell 已重启 ✓';
    if (exitReason?.reason === 'feishu_disconnect') {
      startupMsg = `Shell 已重启 ✓（上次因飞书断连 ${exitReason.downSeconds}s 自动重启）`;
    }

    setTimeout(async () => {
      try {
        await feishu.sendMessage(lastChatId, startupMsg);
        console.log('[shell] Startup notification sent');
      } catch (err) {
        console.warn('[shell] Failed to send startup notification:', err);
      }
    }, 3000);
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[shell] Shutting down (Director stays alive)...');
    director.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[shell] Fatal error:', err);
  process.exit(1);
});

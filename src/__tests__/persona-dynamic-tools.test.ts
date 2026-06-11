import { describe, expect, test } from 'bun:test';
import { handlePersonaDynamicToolCall, PERSONA_DYNAMIC_TOOLS, type PersonaDynamicToolDeps } from '../persona-dynamic-tools.js';
import type { CronJob, Task } from '../task/task-store.js';

const baseCall = {
  namespace: null,
  threadId: 'thread-1',
  turnId: 'turn-1',
  callId: 'call-1',
  sourceSessionId: 'thread-1',
  workspace: 'workspace-a',
};

function deps(overrides: Partial<PersonaDynamicToolDeps> = {}): PersonaDynamicToolDeps {
  return {
    createTask: () => ({ id: 'T-1' }) as Task,
    listTasks: () => [],
    getTask: () => null,
    runTask: () => {},
    createCronJob: (input) => ({ id: 'C-1', ...input, enabled: true, workspace: input.workspace ?? null }) as CronJob,
    listCronJobs: () => [],
    deleteCronJob: () => false,
    toggleCronJob: () => null,
    ...overrides,
  };
}

describe('persona dynamic tools', () => {
  test('exposes task and cron tool schemas from one registry', () => {
    expect(PERSONA_DYNAMIC_TOOLS.map((tool) => tool.name)).toEqual([
      'create_task',
      'list_tasks',
      'get_task',
      'create_cron_job',
      'list_cron_jobs',
      'delete_cron_job',
      'toggle_cron_job',
    ]);
  });

  test('creates cron jobs bound to the caller workspace and session', async () => {
    let workspace: string | undefined;
    let sourceSessionId: string | undefined;
    const result = await handlePersonaDynamicToolCall({
      ...baseCall,
      tool: 'create_cron_job',
      arguments: {
        name: 'daily',
        role: 'system',
        description: 'daily tick',
        prompt: 'tick',
        schedule: 'daily 09:00',
        action_type: 'director_msg',
        message: 'hello',
      },
    }, deps({
      createCronJob: (input) => {
        workspace = input.workspace;
        sourceSessionId = input.source_session_id;
        return { id: 'C-1', ...input, enabled: true, workspace: input.workspace ?? null } as CronJob;
      },
    }));

    expect(result.success).toBe(true);
    expect(workspace).toBe('workspace-a');
    expect(sourceSessionId).toBe('thread-1');
    expect(JSON.parse(result.text).action_type).toBe('director_msg');
  });

  test('lists only cron jobs from the caller workspace', async () => {
    const result = await handlePersonaDynamicToolCall({
      ...baseCall,
      tool: 'list_cron_jobs',
      arguments: {},
    }, deps({
      listCronJobs: () => [
        { id: 'C-1', name: 'a', workspace: 'workspace-a' },
        { id: 'C-2', name: 'b', workspace: 'workspace-b' },
        { id: 'C-3', name: 'main', workspace: null },
      ] as CronJob[],
    }));

    expect(result.success).toBe(true);
    expect(JSON.parse(result.text).map((job: { id: string }) => job.id)).toEqual(['C-1']);
  });

  test('deletes only cron jobs visible in the caller workspace', async () => {
    const deletedIds: string[] = [];
    const result = await handlePersonaDynamicToolCall({
      ...baseCall,
      tool: 'delete_cron_job',
      arguments: { id: 'C-1' },
    }, deps({
      listCronJobs: () => [
        { id: 'C-1', name: 'a', workspace: 'workspace-a' },
        { id: 'C-2', name: 'b', workspace: 'workspace-b' },
      ] as CronJob[],
      deleteCronJob: (id) => {
        deletedIds.push(id);
        return true;
      },
    }));

    expect(result.success).toBe(true);
    expect(deletedIds).toEqual(['C-1']);

    const denied = await handlePersonaDynamicToolCall({
      ...baseCall,
      tool: 'delete_cron_job',
      arguments: { id: 'C-2' },
    }, deps({
      listCronJobs: () => [
        { id: 'C-2', name: 'b', workspace: 'workspace-b' },
      ] as CronJob[],
      deleteCronJob: () => {
        throw new Error('should not delete cross-workspace cron');
      },
    }));

    expect(denied).toEqual({ success: false, text: 'Cron job not found: C-2' });
  });

  test('toggles only cron jobs visible in the caller workspace', async () => {
    const result = await handlePersonaDynamicToolCall({
      ...baseCall,
      tool: 'toggle_cron_job',
      arguments: { id: 'C-1' },
    }, deps({
      listCronJobs: () => [
        { id: 'C-1', name: 'a', workspace: 'workspace-a' },
      ] as CronJob[],
      toggleCronJob: (id) => ({ id, name: 'a', enabled: false, workspace: 'workspace-a' }) as CronJob,
    }));

    expect(result.success).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ id: 'C-1', enabled: false });

    const denied = await handlePersonaDynamicToolCall({
      ...baseCall,
      tool: 'toggle_cron_job',
      arguments: { id: 'C-2' },
    }, deps({
      listCronJobs: () => [
        { id: 'C-2', name: 'b', workspace: 'workspace-b' },
      ] as CronJob[],
      toggleCronJob: () => {
        throw new Error('should not toggle cross-workspace cron');
      },
    }));

    expect(denied).toEqual({ success: false, text: 'Cron job not found: C-2' });
  });
});

import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';

process.env.PERSONA_SESSION_ID = 'env-session-old';
process.env.PERSONA_WORKSPACE = 'workspace-a';
delete process.env.CODEX_THREAD_ID;
delete process.env.CODEX_SESSION_ID;
delete process.env.PERSONA_SESSION_FILE;

const { buildCreateTaskRequest, buildPersonaDelegateTaskRequest } = await import('../task/task-mcp-server.js');

describe('task-mcp-server task source metadata', () => {
  test('create_task prefers Codex per-turn thread metadata over static MCP env session id', () => {
    const request = buildCreateTaskRequest({
      role: 'explorer',
      description: 'audit',
      prompt: 'scan repo',
      _meta: {
        'x-codex-turn-metadata': {
          thread_id: 'codex-thread-current',
          workspaces: { '/repo': {} },
        },
      },
    });

    expect(request.source_session_id).toBe('codex-thread-current');
    expect(request.workspace).toBe('workspace-a');
    expect(request.extra).toEqual({
      codex_callback: {
        type: 'codex_thread',
        thread_id: 'codex-thread-current',
        cwd: '/repo',
      },
    });
  });

  test('persona_delegate keeps Claude/Kimi env fallback when Codex metadata is absent', () => {
    const request = buildPersonaDelegateTaskRequest({
      role: 'executor',
      description: 'fix',
      prompt: 'do it',
    });

    expect(request.source_session_id).toBe('env-session-old');
    expect(request.workspace).toBe('workspace-a');
    expect(request.extra).toEqual({ persona_role: 'executor' });
  });



  test('uses lazy session file before stale env session id when metadata is absent', () => {
    const sessionFile = '/tmp/persona-task-mcp-session-file-test';
    writeFileSync(sessionFile, 'file-session-current\n');
    process.env.PERSONA_SESSION_FILE = sessionFile;
    try {
      const request = buildCreateTaskRequest({
        role: 'explorer',
        description: 'file source',
        prompt: 'read source file',
      });

      expect(request.source_session_id).toBe('file-session-current');
    } finally {
      delete process.env.PERSONA_SESSION_FILE;
      rmSync(sessionFile, { force: true });
    }
  });

  test('explicit Codex callback target does not steal Claude/Kimi source session', () => {
    const request = buildCreateTaskRequest({
      role: 'explorer',
      description: 'callback',
      prompt: 'report back',
      callback_codex_thread_id: 'manual-codex-thread',
    });

    expect(request.source_session_id).toBe('env-session-old');
    expect(request.extra).toEqual({
      codex_callback: {
        type: 'codex_thread',
        thread_id: 'manual-codex-thread',
        cwd: process.env.PWD,
      },
    });
  });
});

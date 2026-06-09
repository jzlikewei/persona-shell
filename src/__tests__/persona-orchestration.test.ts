import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  buildPersonaPromptBundle,
  listPersonaRoles,
  readPersonaMemory,
  upsertSessionLink,
  writePersonaMemory,
} from '../persona-orchestration.js';

const TEST_DIR = '/tmp/persona-orchestration-test';

describe('persona orchestration', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, 'personas'), { recursive: true });
    mkdirSync(join(TEST_DIR, 'memory'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'soul.md'), 'Soul prompt');
    writeFileSync(join(TEST_DIR, 'meta.md'), 'Meta prompt');
    writeFileSync(join(TEST_DIR, 'prompts.md'), 'Agent prompt');
    writeFileSync(
      join(TEST_DIR, 'personas', 'critic.md'),
      [
        '---',
        'name: Critic',
        'description: Checks risk',
        '---',
        '',
        '# Critic Role',
        '',
        'Critic prompt',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('lists persona roles from frontmatter', () => {
    expect(listPersonaRoles(TEST_DIR)).toEqual([{
      role: 'critic',
      path: join(TEST_DIR, 'personas', 'critic.md'),
      name: 'Critic',
      description: 'Checks risk',
    }]);
  });

  test('builds Codex instruction bundle from base and role prompts', () => {
    const bundle = buildPersonaPromptBundle(TEST_DIR, 'critic', { systemPromptFile: 'prompts.md' });

    expect(bundle.baseInstructions).toContain('Soul prompt');
    expect(bundle.baseInstructions).toContain('Meta prompt');
    expect(bundle.developerInstructions).toContain('Agent prompt');
    expect(bundle.developerInstructions).toContain('Critic prompt');
    expect(bundle.files.base).toHaveLength(2);
    expect(bundle.files.developer).toHaveLength(2);
  });

  test('reads and writes workspace memory safely', () => {
    const written = writePersonaMemory(TEST_DIR, 'workspace', 'project-a', '# Context');
    expect(written.path).toBe(join(TEST_DIR, 'workspaces', 'project-a', 'context.md'));
    expect(readFileSync(written.path, 'utf-8')).toBe('# Context');

    expect(readPersonaMemory(TEST_DIR, 'workspace', 'project-a')).toEqual({
      path: written.path,
      content: '# Context',
    });
  });

  test('blocks memory paths outside persona dir', () => {
    expect(() => readPersonaMemory(TEST_DIR, 'workspace', '../../../../etc/passwd')).toThrow();
  });

  test('upserts session links by channel and external id', () => {
    const links = upsertSessionLink(null, {
      channel: 'feishu',
      externalId: 'oc_1',
      personaSessionId: 'sess-1',
      codexThreadId: 'thread-1',
      sessionId: 'sess-1',
      workspace: 'main',
      legacyDirectorLabel: 'main',
      role: 'director',
    });

    expect(links['feishu:oc_1']).toMatchObject({
      channel: 'feishu',
      externalId: 'oc_1',
      personaSessionId: 'sess-1',
      codexThreadId: 'thread-1',
      sessionId: 'sess-1',
      workspace: 'main',
      legacyDirectorLabel: 'main',
      role: 'director',
    });
    expect(links['feishu:oc_1'].updatedAt).toBeTruthy();
  });
});

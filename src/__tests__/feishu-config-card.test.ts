import { describe, expect, test } from 'bun:test';
import { buildFeishuConfigCard } from '../messaging/feishu-config-card.js';

describe('buildFeishuConfigCard', () => {
  test('builds a control card for session agent and cwd settings', () => {
    const card = buildFeishuConfigCard({
      workspaceName: 'p.sh维修',
      cwd: '/Users/ilike/github/jzlikewei/persona-shell',
      workspaceAgent: 'codex',
      defaultSessionId: '019eb562-0c60-7673-bb4b-6699d97fb722',
      sessions: [
        {
          sessionId: '019eb562-0c60-7673-bb4b-6699d97fb722',
          name: 'ETF worker',
          agentName: 'codex',
          agentType: 'codex-app-server',
          model: 'gpt-5',
          alive: true,
          isDefault: true,
        },
      ],
      agents: [
        { name: 'codex', type: 'codex-app-server', model: 'gpt-5' },
        { name: 'claude', type: 'claude' },
      ],
    });

    const json = JSON.stringify(card);
    expect(card.schema).toBe('2.0');
    expect(card.header.title.content).toBe('配置 · p.sh维修');
    expect(json).toContain('persona_config_set_session');
    expect(json).toContain('persona_config_switch_agent');
    expect(json).toContain('persona_config_new_session');
    expect(json).toContain('persona_config_cwd_help');
    expect(json).toContain('/Users/ilike/github/jzlikewei/persona-shell');
  });
});

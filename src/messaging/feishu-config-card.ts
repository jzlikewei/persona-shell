import type { FeishuCard } from './feishu-card-stream.js';

export interface ConfigCardSession {
  sessionId: string;
  name?: string | null;
  agentName?: string | null;
  agentType?: string | null;
  model?: string | null;
  alive: boolean;
  isDefault: boolean;
  lastMessageAt?: string | null;
}

export interface ConfigCardState {
  workspaceName: string;
  cwd?: string | null;
  workspaceAgent?: string | null;
  defaultSessionId?: string | null;
  sessions: ConfigCardSession[];
  agents: Array<{ name: string; type?: string; model?: string | null }>;
  notice?: string;
}

type ButtonType = 'default' | 'primary' | 'danger';

type ButtonElement = Extract<FeishuCard['body']['elements'][number], { tag: 'column_set' }>['columns'][number]['elements'][number];

function button(text: string, type: ButtonType, value: Record<string, string>): ButtonElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value,
  };
}

function actionRow(buttons: ButtonElement[]): FeishuCard['body']['elements'][number] {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    columns: buttons.map((item) => ({ tag: 'column', width: 'auto', elements: [item] })),
  };
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function formatSessionLine(session: ConfigCardSession): string {
  const bits = [
    session.isDefault ? '✅ default' : '可切换',
    session.alive ? 'live' : 'sleep',
    session.agentName ? `${session.agentName}${session.agentType ? `/${session.agentType}` : ''}` : 'agent:-',
    session.model ? `model:${session.model}` : null,
  ].filter(Boolean);
  const name = session.name?.trim() || shortId(session.sessionId);
  return `- **${name}** · \`${shortId(session.sessionId)}\` · ${bits.join(' · ')}`;
}

function formatAgentLabel(agent: { name: string; type?: string; model?: string | null }): string {
  const suffix = agent.model ? ` · ${agent.model}` : agent.type ? ` · ${agent.type}` : '';
  return `${agent.name}${suffix}`;
}

export function buildFeishuConfigCard(state: ConfigCardState): FeishuCard {
  const elements: FeishuCard['body']['elements'] = [];
  if (state.notice?.trim()) {
    elements.push({ tag: 'markdown', content: `**${state.notice.trim()}**` });
    elements.push({ tag: 'hr' });
  }

  elements.push({
    tag: 'markdown',
    content: [
      `**Workspace**: ${state.workspaceName}`,
      `**工作目录**: ${state.cwd ? `\`${state.cwd}\`` : '未配置'}`,
      `**Workspace 默认 Agent**: ${state.workspaceAgent ?? '默认'}`,
      `**Default Session**: ${state.defaultSessionId ? `\`${shortId(state.defaultSessionId)}\`` : '未设置'}`,
    ].join('\n'),
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: state.sessions.length > 0
      ? `**Sessions**\n${state.sessions.slice(0, 6).map(formatSessionLine).join('\n')}`
      : '**Sessions**\n暂无 session。可以先新建一个。',
  });

  for (const session of state.sessions.slice(0, 4)) {
    const label = session.isDefault ? `当前 ${shortId(session.sessionId)}` : `切到 ${shortId(session.sessionId)}`;
    elements.push(actionRow([
      button(label, session.isDefault ? 'default' : 'primary', {
        action: 'persona_config_set_session',
        workspace: state.workspaceName,
        sessionId: session.sessionId,
      }),
    ]));
  }

  elements.push({ tag: 'hr' });
  const preferredAgents = state.agents.filter((agent) => ['codex', 'claude'].includes(agent.name)).slice(0, 2);
  const agentButtons = preferredAgents.map((agent) => button(`切 ${agent.name}`, agent.name === 'codex' ? 'primary' : 'default', {
    action: 'persona_config_switch_agent',
    workspace: state.workspaceName,
    agent: agent.name,
  }));
  if (agentButtons.length > 0) elements.push(actionRow(agentButtons));

  elements.push(actionRow([
    button('新建 Codex Session', 'primary', { action: 'persona_config_new_session', workspace: state.workspaceName, agent: 'codex' }),
    button('新建 Claude Session', 'default', { action: 'persona_config_new_session', workspace: state.workspaceName, agent: 'claude' }),
  ]));

  elements.push(actionRow([
    button('修改 cwd', 'default', { action: 'persona_config_cwd_help', workspace: state.workspaceName }),
    button('刷新', 'default', { action: 'persona_config_refresh', workspace: state.workspaceName }),
  ]));

  if (state.agents.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**可用 Agent**: ${state.agents.map(formatAgentLabel).join(' / ')}`,
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `配置 · ${state.workspaceName}` },
      subtitle: { tag: 'plain_text', content: 'session / agent / cwd' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'settings_outlined' },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: '控制面' }, color: 'blue' },
      ],
    },
    body: { elements },
  };
}

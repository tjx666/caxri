import type { TranslatedNamespace } from '@caxri/protocol';

import type { agentActivity as source } from '../en/agent-activity';

export const agentActivity: TranslatedNamespace<typeof source> = {
    'agentActivity.treeLabel': '活动',
    'agentActivity.recapLabel': '回顾：',
    'agentActivity.empty': '没有等待你处理的 Agent 会话。',
    'agentActivity.emptyHint': '已完成或需要你回答的会话会显示在这里。',
    'agentActivity.markDoneFailed': '无法将会话标为已处理',
    'agentActivity.group.pinned': '置顶',
    'agentActivity.group.attention': '需要处理',
    'agentActivity.group.idle': '空闲',
    'agentActivity.group.working': '运行中',
    'agentActivity.heading.sessionsOne': '{{count}} 个会话',
    'agentActivity.heading.sessionsOther': '{{count}} 个会话',
    'agentActivity.heading.collapsed': '{{summary}}，已折叠',
    'agentActivity.revealAriaLabelOne': '在“{{group}}”中再显示 {{count}} 个会话',
    'agentActivity.revealAriaLabelOther': '在“{{group}}”中再显示 {{count}} 个会话',
    'agentActivity.glyph.detached': '已分离',
    'agentActivity.markDone': '标为已处理',
    'agentActivity.markSessionDone': '将 {{title}} 标为已处理',
    'agentActivity.note.background': '等后台任务',
};

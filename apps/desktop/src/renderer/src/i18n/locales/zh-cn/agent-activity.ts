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
    'agentActivity.markAllDone.action': '全部标为已处理',
    'agentActivity.markAllDone.title': '全部标为已处理？',
    'agentActivity.markAllDone.messageOne':
        '“需要处理”中的 {{count}} 个会话将移到“空闲”，对话和 Agent 不受影响。若其 Agent 有新动态，会话仍留在“需要处理”。',
    'agentActivity.markAllDone.messageOther':
        '“需要处理”中的 {{count}} 个会话将移到“空闲”，对话和 Agent 不受影响。有新动态的会话仍留在“需要处理”。',
    'agentActivity.markAllDone.confirm': '标记 {{count}} 个为已处理',
    'agentActivity.markAllDone.resolvedNone': '没有会话被标为已处理',
    'agentActivity.markAllDone.resolvedOne': '已将 {{count}} 个会话标为已处理',
    'agentActivity.markAllDone.resolvedOther': '已将 {{count}} 个会话标为已处理',
    'agentActivity.markAllDone.stayedOne': '；{{count}} 个有新动态，仍留在“需要处理”',
    'agentActivity.markAllDone.stayedOther': '；{{count}} 个有新动态，仍留在“需要处理”',
    'agentActivity.markAllDone.failed': '无法将这些会话标为已处理',
    'agentActivity.note.background': '等后台任务',
};

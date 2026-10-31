import type { TranslatedNamespace } from '@caxri/protocol';

import type { agentActivity as source } from '../en/agent-activity';

export const agentActivity: TranslatedNamespace<typeof source> = {
    'agentActivity.treeLabel': '活动',
    'agentActivity.empty': '没有等待你处理的 Agent 会话。',
    'agentActivity.markReadFailed': '无法将会话标记为已读',
    'agentActivity.group.pinned': '置顶',
    'agentActivity.group.attention': '待处理',
    'agentActivity.group.failed': '失败',
    'agentActivity.group.finished': '最近完成',
    'agentActivity.group.idle': '空闲',
    'agentActivity.group.waiting': '等待中',
    'agentActivity.group.working': '运行中',
    'agentActivity.group.viewing': '正在查看',
    'agentActivity.heading.readSessionsOne': '{{count}} 个已读会话',
    'agentActivity.heading.readSessionsOther': '{{count}} 个已读会话',
    'agentActivity.heading.unreadSessionsOne': '{{count}} 个未读会话',
    'agentActivity.heading.unreadSessionsOther': '{{count}} 个未读会话',
    'agentActivity.heading.sessionsOne': '{{count}} 个会话',
    'agentActivity.heading.sessionsOther': '{{count}} 个会话',
    'agentActivity.revealAriaLabelOne': '在“{{group}}”中再显示 {{count}} 个会话',
    'agentActivity.revealAriaLabelOther': '在“{{group}}”中再显示 {{count}} 个会话',
    'agentActivity.glyph.detached': '已分离',
    'agentActivity.viewedAndRead': '已查看并已读',
    'agentActivity.markRead': '标为已读',
    'agentActivity.markSessionRead': '将 {{title}} 标为已读',
};

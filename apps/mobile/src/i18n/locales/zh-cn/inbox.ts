import type { TranslatedNamespace } from '@caxri/protocol';

import type { inbox as source } from '../en/inbox';

export const inbox: TranslatedNamespace<typeof source> = {
    'inbox.ageAgo': '{{age}}前',
    'inbox.back': '返回',
    'inbox.bodyClipped': '手机上显示的是缩略内容，完整文本在电脑上。',
    'inbox.changedSinceVerified': '验证后已变更',
    'inbox.earlierRepliesOne': '更早的 {{count}} 条回复',
    'inbox.earlierRepliesOther': '更早的 {{count}} 条回复',
    'inbox.empty': '目前没有需要你处理的事项。',
    'inbox.loadFailed': '无法加载需要你处理的事项。',
    'inbox.offline': '重新连接以查看需要你处理的事项。',
    'inbox.openPullRequestHint': '打开 Pull Request。',
    'inbox.refreshFailed': '无法刷新，正在显示上次获取的事项。',
    'inbox.reply': '回复',
    'inbox.replyFailed': '无法发送回复。',
    'inbox.replyPlaceholder': '回复 Caxri Bot',
    'inbox.replyTo': '回复「{{title}}」',
    'inbox.send': '发送',
    'inbox.staleNotice': '连接已断开，正在显示上次获取的事项。',
    'inbox.title': '需要你处理',
    'inbox.truncated': '显示 {{total}} 项中的 {{shown}} 项，其余在电脑上。',
};

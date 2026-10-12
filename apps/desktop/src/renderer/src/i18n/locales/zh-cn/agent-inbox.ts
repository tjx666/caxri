import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { agentInbox as source } from '../en/agent-inbox';

export const agentInbox: TranslatedNamespace<typeof source> = {
    'agentInbox.body.readFailed': '无法读取完整消息。',
    'agentInbox.body.readFailedHint':
        '即使没有完整内容，仍可批准或拒绝：批准只会投递这条消息，不授予任何权限。如需先阅读全文，可点击重试加载。',
    'agentInbox.body.loading': '正在加载完整消息…',
    'agentInbox.summary.sender': '发送方',
    'agentInbox.summary.project': '项目',
    'agentInbox.summary.provider': '提供方',
    'agentInbox.summary.permission': '权限',
    'agentInbox.summary.endpoint': '端点',
    'agentInbox.summary.expired': '已过期',
    'agentInbox.summary.expires': '过期时间',
    'agentInbox.actions.hint':
        '“稍后决定”、按 Escape 或关闭此对话框都会让请求继续等待，均不会答复发送方。',
    'agentInbox.actions.decideLater': '稍后决定',
    'agentInbox.actions.deny': '拒绝',
    'agentInbox.actions.approve': '批准消息',
    'agentInbox.dialog.titleExpired': '对等消息已过期',
    'agentInbox.dialog.title': '对等消息审批',
    'agentInbox.dialog.description':
        '这是 Agent 之间传递的纯文本。批准只会投递这条消息，不会授予权限、更改设置或执行命令。',
    'agentInbox.dialog.expiredNotice': '此请求在答复前已过期，无法再批准或拒绝，消息也未投递。',
    'agentInbox.dialog.loadBodyFailed': '无法加载完整的对等消息',
    'agentInbox.dialog.approveFailed': '无法批准对等消息',
    'agentInbox.dialog.denyFailed': '无法拒绝对等消息',
    'agentInbox.waitingList.label': '等待你决定的对等消息',
    'agentInbox.waitingList.title': '等待你的决定',
    'agentInbox.waitingList.hint': '尚未答复任何请求。每个发送方都会等待，直到审批时限结束。',
    'agentInbox.waitingList.until': '截止 {{time}}',
    'agentInbox.waitingList.reviewLabel': '查看来自 {{name}} 的消息',
    'agentInbox.waitingList.review': '查看',
    'agentInbox.store.loadFailed': '无法加载待审批的对等消息',
};

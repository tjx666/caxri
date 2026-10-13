import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { agentChatRequests as source } from '../en/agent-chat-requests';

export const agentChatRequests: TranslatedNamespace<typeof source> = {
    'agentChat.approval.run': '运行',
    'agentChat.approval.allow': '允许',
    'agentChat.approval.applyChanges': '应用更改',
    'agentChat.approval.startBuilding': '开始构建',
    'agentChat.approval.alwaysAllow': '在此对话中始终允许',
    'agentChat.approval.deny': '拒绝',
    'agentChat.approval.keepPlanning': '继续规划',

    'agentChat.request.title.network': '允许访问网络 {{host}}？',
    'agentChat.request.title.command': '运行此命令？',
    'agentChat.request.title.fileChange': '应用这些文件更改？',
    'agentChat.request.title.plan': '按此计划开始？',
    'agentChat.request.title.mcp': '允许使用 {{server}} 的 {{subject}}？',
    'agentChat.request.title.tool': '允许使用 {{name}}？',
    'agentChat.request.title.actionSubject': '允许{{action}} {{subject}}？',
    'agentChat.request.title.action': '允许{{action}}？',
    'agentChat.request.title.questionOne': '{{provider}} 有一个问题',
    'agentChat.request.title.questionOther': '{{provider}} 有 {{count}} 个问题',
    'agentChat.request.action.agent': '运行 Agent',
    'agentChat.request.action.command': '运行',
    'agentChat.request.action.edit': '编辑',
    'agentChat.request.action.image': '查看图片',
    'agentChat.request.action.list': '列出',
    'agentChat.request.action.plan': '更新计划',
    'agentChat.request.action.question': '提问',
    'agentChat.request.action.read': '读取',
    'agentChat.request.action.search': '搜索',
    'agentChat.request.action.skill': '使用 Skill',
    'agentChat.request.action.stop': '停止',
    'agentChat.request.action.thought': '思考',
    'agentChat.request.action.wait': '等待 Agent',
    'agentChat.request.action.web': '浏览',
    'agentChat.request.action.write': '写入',

    'agentChat.waiting.approval': '等待你的批准',
    'agentChat.waiting.answer': '等待你的回答',

    'agentChat.failure.executableNotFound':
        '{{provider}} 未安装或不在 PATH 中。请先安装，然后重试。',
    'agentChat.failure.spawnFailed':
        '无法启动 {{provider}}。请重试，或检查 {{provider}} CLI 能否在终端中运行。',
    'agentChat.failure.handshakeFailed':
        '{{provider}} 已启动但没有响应。请重试，或更新 {{provider}} CLI。',
    'agentChat.failure.processExited': '{{provider}} 意外停止。重试即可恢复对话。',
    'agentChat.failure.resumeFailed': '无法恢复之前的对话。',
    'agentChat.failure.conversationInUse': '此对话已在另一个 {{provider}} 应用或窗口中打开。',
    'agentChat.failure.unsupportedVersion':
        '此 {{provider}} 版本不支持对话。请更新 {{provider}} CLI。',
};

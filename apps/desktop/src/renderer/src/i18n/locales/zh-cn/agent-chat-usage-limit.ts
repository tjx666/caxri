import type { TranslatedNamespace } from '@caxri/protocol';

import type { agentChatUsageLimit as source } from '../en/agent-chat-usage-limit';

export const agentChatUsageLimit: TranslatedNamespace<typeof source> = {
    'agentChat.usageLimit.session': '{{provider}} 的 5 小时额度已用完',
    'agentChat.usageLimit.weekly': '{{provider}} 的每周额度已用完',
    'agentChat.usageLimit.unknown': '{{provider}} 的额度已用完',
    'agentChat.usageLimit.continueIn': '在 {{provider}} 中继续',
    'agentChat.usageLimit.continueElsewhere': '在其他 Agent 中继续',
    'agentChat.usageLimit.chooseAgent': '选择其他 Agent',
    'agentChat.usageLimit.continueTooltip':
        '在此项目中新建会话，由 {{provider}} 接着这段对话继续工作',
    'agentChat.usageLimit.noTarget': '没有其他 Agent 可以接手',
    'agentChat.usageLimit.continueFailed': '无法在其他 Agent 中继续',
    'agentChat.usageLimit.auto.waiting': '将在 {{time}} 自动继续（{{duration}}后）',
    'agentChat.usageLimit.auto.continuing': '正在自动继续…',
    'agentChat.usageLimit.auto.continued': '已于 {{time}} 自动继续',
    'agentChat.usageLimit.auto.missed': '额度已重置',
    'agentChat.usageLimit.auto.skipped.resetUnknown': '不会自动继续：未获得重置时间',
    'agentChat.usageLimit.auto.skipped.resetTooFar': '不会自动继续：额度要 24 小时以后才重置',
    'agentChat.usageLimit.auto.skipped.attemptsUsed':
        '已连续自动继续 {{count}} 次仍遇到限额，不再自动继续',
    'agentChat.usageLimit.auto.skipped.usageGuard': '每周额度已达保护线，不会自动继续',
    'agentChat.usageLimit.auto.continueNow': '立即继续',
    'agentChat.usageLimit.auto.continue': '继续',
    'agentChat.usageLimit.auto.cancel': '取消',
    'agentChat.usageLimit.auto.cancelTooltip': '不再等待，对话保持现状',
    'agentChat.usageLimit.auto.continueFailed': '无法继续此对话',
    'agentChat.usageLimit.auto.cancelFailed': '无法取消自动继续',
    'agentChat.usageLimit.unavailable.current': '当前对话',
    'agentChat.usageLimit.unavailable.notInstalled': '未安装',
    'agentChat.usageLimit.unavailable.unsupported': '不支持对话',
    'agentChat.usageLimit.unavailable.usageLimited': '每周额度已达保护线',
    'agentChat.usageLimit.unavailable.usageLimitedUntil': '每周额度已达保护线，{{reset}}',
    'agentChat.message.sendBlockedUsageGuard': '每周额度即将用完，请在下方交接',
    'agentChat.queue.pausedUsageGuard': '队列已暂停 · 每周额度即将用完',
    'agentChat.creditsNotice.credits': '{{provider}} 每周额度已用 {{percent}}%：新请求改用积分继续',
    'agentChat.creditsNotice.creditsLeft':
        '{{provider}} 每周额度已用 {{percent}}%：新请求改用积分继续，剩余 {{balance}}',
    'agentChat.creditsNotice.extraUsage':
        '{{provider}} 每周额度已用 {{percent}}%：新请求改用额外用量继续',
    'agentChat.creditsNotice.extraUsageLeft':
        '{{provider}} 每周额度已用 {{percent}}%：新请求改用额外用量继续，本月剩余 {{balance}}',
    'agentChat.creditsNotice.detail': '每周额度重置前，新请求会消耗账号积分（{{reset}}）。',
    'agentChat.creditsNotice.dismiss': '一天内不再提示',
    'agentChat.usageGuard.headline': '{{provider}} 每周额度已用 {{percent}}%',
    'agentChat.usageGuard.detail': '新请求已暂停，{{reset}}。剩余额度留给此账号的一次交接。',
    'agentChat.usageGuard.generate': '生成交接文档',
    'agentChat.usageGuard.generateTooltip':
        '由 {{provider}} 用保留的额度写一份交接文档。每个账号在每周重置前只能生成一次',
    'agentChat.usageGuard.generating': '正在写交接文档…',
    'agentChat.usageGuard.used': '此账号本周已用过交接额度',
    'agentChat.usageGuard.generateFailed': '无法生成交接文档',
    'agentChat.usageGuard.openElsewhere': '在其他 Agent 中打开',
    'agentChat.usageGuard.document': '交接文档',
    'agentChat.usageGuard.copy': '复制交接文档',
    'agentChat.usageGuard.failed.rejected': '交接请求被拒绝。在其他 Agent 中打开仍会带上这段对话',
    'agentChat.usageGuard.failed.timeout': '交接超时。在其他 Agent 中打开仍会带上这段对话',
    'agentChat.usageGuard.failed.unavailable': '交接未能开始。在其他 Agent 中打开仍会带上这段对话',
    'agentChat.usageGuard.failed.empty': '交接文档为空。在其他 Agent 中打开仍会带上这段对话',
    'agentChat.usageGuard.continuedIn': '已在此继续',
};

import type { TranslatedNamespace } from '@caxri/protocol';

import type { settingsClaudeWindows as source } from '../en/settings-claude-windows';

export const settingsClaudeWindows: TranslatedNamespace<typeof source> = {
    'settings.claudeWindows.loading': '正在检查 Claude 账号…',
    'settings.claudeWindows.loadFailed': '无法检查 Claude 账号。',
    'settings.claudeWindows.saveFailed': '保存失败。Claude 账号可能已变更，请重试。',
    'settings.claudeWindows.plan.pro': 'Claude Pro',
    'settings.claudeWindows.plan.max': 'Claude Max',
    'settings.claudeWindows.planLine': '计划：{{plan}}',
    'settings.claudeWindows.keepRolling': '保持 5 小时窗口滚动',
    'settings.claudeWindows.keepRollingDescription':
        '上一个 5 小时窗口重置时，用一次最小请求开启下一个窗口，让当天第一个窗口在上班时重置。Pro 默认开启，Max 默认关闭。为了在 Caxri 关闭时也能工作，它会向 macOS 注册一个后台任务（显示在“登录项”中）；关闭此功能会将其移除。',
    'settings.claudeWindows.defaultNotice':
        'Caxri 会保持你的 Claude 5 小时窗口滚动：每个窗口重置时，向 Claude 发送一次最小请求开启下一个窗口，Caxri 关闭时也会继续。Claude Pro 默认开启。',
    'settings.claudeWindows.firstWorkdayReset': '上班后首次重置时间',
    'settings.claudeWindows.warmUpNote':
        'Caxri 会提前五小时在 {{warmUp}} 开启预热窗口，使其在 {{reset}} 重置。',
    'settings.claudeWindows.nextWarmUp': '下次预热',
    'settings.claudeWindows.nextWorkdayReset': '下次上班重置',
    'settings.claudeWindows.lastOutcomeLabel': '上次检查',
    'settings.claudeWindows.lastOutcome': '{{outcome}} · {{time}}{{missed}}',
    'settings.claudeWindows.time.today': '今天 {{time}}',
    'settings.claudeWindows.time.tomorrow': '明天 {{time}}',
    'settings.claudeWindows.time.yesterday': '昨天 {{time}}',
    'settings.claudeWindows.time.date': '{{month}}/{{day}} {{time}}',
    'settings.claudeWindows.status.off': '已关闭',
    'settings.claudeWindows.status.waitingForAnchor': '等待下次预热',
    'settings.claudeWindows.status.windowActive': '窗口进行中，{{time}} 重置',
    'settings.claudeWindows.status.waitingForNaturalReset':
        '窗口进行中，{{time}} 重置；下次预热会重新对齐当天',
    'settings.claudeWindows.status.triggering': '正在开启窗口…',
    'settings.claudeWindows.status.confirmed': '已开启窗口，{{time}} 重置',
    'settings.claudeWindows.status.unavailable': '已暂停',
    'settings.claudeWindows.status.unavailableBecause': '已暂停：{{reason}}',
    'settings.claudeWindows.reason.notSignedIn': 'Claude Code 未登录 Claude 账号',
    'settings.claudeWindows.reason.authUnsupported':
        'Claude Code 使用 API key 或其他提供方，请求会按 API 计费',
    'settings.claudeWindows.reason.planUnsupported': '当前计划不是 Claude Pro 或 Max',
    'settings.claudeWindows.reason.usageUnavailable': 'Claude Code 未报告 5 小时窗口',
    'settings.claudeWindows.reason.weeklyLimit': '本周额度已用完',
    'settings.claudeWindows.reason.claudeNotFound': '未安装 Claude Code',
    'settings.claudeWindows.reason.probeFailed': 'Claude Code 没有响应',
    'settings.claudeWindows.outcome.naturalWindowStarted': '你自己的请求开启了窗口',
    'settings.claudeWindows.outcome.triggerConfirmed': '已开启窗口',
    'settings.claudeWindows.outcome.triggerUnverified': '已发送请求，但没有出现新窗口',
    'settings.claudeWindows.outcome.triggerFailed': '请求失败',
    'settings.claudeWindows.outcome.renewalSkipped': '跳过一次续期，让早上的预热重新开始',
    'settings.claudeWindows.outcome.weeklyLimit': '已跳过：本周额度已用完',
    'settings.claudeWindows.outcome.authUnsupported': '已跳过：不支持的登录方式',
    'settings.claudeWindows.outcome.missedWhileAsleep': '睡眠唤醒后已补做',
    'settings.claudeWindows.outcome.missedSuffix': '（原定 {{time}}，因睡眠错过）',
    'settings.claudeWindows.background.unpackaged':
        '开发构建不注册后台任务，仅在 Caxri 运行时保持窗口。',
    'settings.claudeWindows.background.unsupportedPlatform':
        '在此平台上仅在 Caxri 运行时保持窗口。',
    'settings.claudeWindows.background.registerFailed':
        '无法注册后台任务，仅在 Caxri 运行时保持窗口。',
};

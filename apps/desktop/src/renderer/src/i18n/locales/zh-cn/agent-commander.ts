import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { agentCommander as source } from '../en/agent-commander';

export const agentCommander: TranslatedNamespace<typeof source> = {
    // Window chrome
    'agentCommander.window.title': 'Agent Commander',
    'agentCommander.window.sessionsLabel': '会话',
    'agentCommander.window.stop': '停止',
    'agentCommander.window.stopTooltip':
        '停止 Commander 并关闭此窗口。它委派的任务会继续运行，再次打开时会恢复同一段对话。',
    'agentCommander.window.needsYou': '需要你处理',
    'agentCommander.window.hideNeedsYou': '隐藏“需要你处理”',
    'agentCommander.window.showColumn': '显示“{{column}}”',
    'agentCommander.window.hideColumn': '隐藏“{{column}}”',
    'agentCommander.window.resizeNeedsYou': '调整“需要你处理”宽度',

    // Commander Terminal
    'agentCommander.terminal.couldNotStart': 'Agent Commander 无法启动。',
    'agentCommander.terminal.starting': '正在启动 Agent Commander…',
    'agentCommander.terminal.ariaLabel': 'Agent Commander：{{title}}',
    'agentCommander.terminal.startFailed': '无法启动 Agent Commander',
    'agentCommander.terminal.noLongerSetUp':
        'Agent Commander 已不再处于配置状态。请关闭此窗口后重新打开。',

    // Board
    'agentCommander.board.loadFailed': '无法加载看板',
    'agentCommander.board.loading': '正在加载 Agent…',
    'agentCommander.board.emptyCommander':
        '暂无 Commander 管理的会话。向 Commander 描述一个目标，或转交你开始的会话，它们会显示在这里。',
    'agentCommander.board.emptyAll': '暂无会话。所有项目的会话会在其 Agent 工作时显示在这里。',
    'agentCommander.board.scopeLabel': '看板范围',
    'agentCommander.board.scopeCommander': 'Commander',
    'agentCommander.board.scopeCommanderLabel': 'Commander 管理的会话',
    'agentCommander.board.scopeAll': '全部',
    'agentCommander.board.scopeAllLabel': '所有会话',
    'agentCommander.board.group.attention': '待处理',
    'agentCommander.board.group.failed': '失败',
    'agentCommander.board.group.finished': '最近完成',
    'agentCommander.board.group.idle': '空闲',
    'agentCommander.board.group.waiting': '等待中',
    'agentCommander.board.group.working': '工作中',
    'agentCommander.board.process.exited': '已退出',
    'agentCommander.board.process.detached': '已分离',
    'agentCommander.board.process.failed': '启动失败',
    'agentCommander.board.process.interrupted': '已中断',
    'agentCommander.board.process.starting': '正在启动',
    'agentCommander.board.process.suspended': '已挂起',
    'agentCommander.board.noTerminal': '无终端',
    'agentCommander.board.shell': 'Shell',
    'agentCommander.board.unread': '未读。{{state}}',
    'agentCommander.board.pullRequestOpen': '{{label}} 在浏览器中打开。',
    'agentCommander.board.ownedSession': '由 Agent Commander 创建，以便向这里委派任务。',
    'agentCommander.board.commanderTask': 'Commander 任务。{{description}}',

    // Board task status
    'agentCommander.task.label.answered': '已回答',
    'agentCommander.task.label.blocked': '受阻',
    'agentCommander.task.label.failed': '失败',
    'agentCommander.task.label.running': '运行中',
    'agentCommander.task.label.starting': '正在启动',
    'agentCommander.task.label.stopped': '已停止',
    'agentCommander.task.label.takenOver': '已由你收回',
    'agentCommander.task.label.waitingAtStartup': '启动时等待',
    'agentCommander.task.description.answerUnavailable': 'Agent 已完成，但无法读回它的回答。',
    'agentCommander.task.description.awaitingReady': 'Agent 正在启动，尚未开始该任务。',
    'agentCommander.task.description.blocked': 'Agent 停下来提问，通常由 Commander 回答。',
    'agentCommander.task.description.collecting': 'Agent 已结束本轮，Commander 正在读取它的回答。',
    'agentCommander.task.description.completed':
        'Agent 已给出最终回答。Commander 会先验证，再进行汇报。',
    'agentCommander.task.description.failed': '任务失败。',
    'agentCommander.task.description.humanIntervened':
        '任务运行期间你在此会话中输入过内容，因此它现在归你所有。Commander 不再驱动它，也不会再发送后续指令。',
    'agentCommander.task.description.interrupted': '任务在 Agent 完成前已停止。',
    'agentCommander.task.description.launching': 'Commander 正在为此任务启动 Agent。',
    'agentCommander.task.description.running': 'Agent 正在处理该任务。',
    'agentCommander.task.description.submitting': 'Commander 正在把任务交给 Agent。',
    'agentCommander.task.waitingAtStartupTitle':
        '启动时等待。Agent 已运行但尚未开始，通常停在首次运行的提示上，例如文件夹信任或登录。打开该会话进行回应，任务随后会自行继续。任务 {{delegationId}}。',
    'agentCommander.task.reason': '原因：{{reason}}。',
    'agentCommander.task.title': '{{label}}。{{description}}{{reason}}任务 {{delegationId}}。',

    // Inbox
    'agentCommander.inbox.hideColumn': '隐藏此栏',
    'agentCommander.inbox.loadFailed': '无法加载收件箱',
    'agentCommander.inbox.loading': '正在加载收件箱…',
    'agentCommander.inbox.empty':
        '暂无需要你处理的事项。当 Commander 有问题或有可合并的 Pull Request 时，会显示在这里。',
    'agentCommander.inbox.section.merge': '可合并',
    'agentCommander.inbox.section.questions': '问题',
    'agentCommander.inbox.openPullRequest': '在浏览器中打开 Pull Request',
    'agentCommander.inbox.showSession': '在工作台中显示此会话',
    'agentCommander.inbox.session': '会话',
    'agentCommander.inbox.answers': '回答',
    'agentCommander.inbox.merging': '正在合并…',
    'agentCommander.inbox.merge': '合并',
    'agentCommander.inbox.mergeTooltip': '合并 Commander 已验证的提交',
    'agentCommander.inbox.reply': '回复',
    'agentCommander.inbox.kind.decision': '决策',
    'agentCommander.inbox.kind.hands': '需要你',
    'agentCommander.inbox.kind.merge': 'Pull Request',
    'agentCommander.inbox.replyState.read': 'Commander 已读',
    'agentCommander.inbox.replyState.delivered': '已送达 Commander',

    // Inbox merge readiness
    'agentCommander.mergeState.changedSinceVerified': '验证后已变更',
    'agentCommander.mergeState.changedSinceVerifiedReason':
        'Commander 验证此 Pull Request 后又有新提交。合并前它会重新验证。',
    'agentCommander.mergeState.draft': '草稿',
    'agentCommander.mergeState.draftReason': '此 Pull Request 仍是草稿。',
    'agentCommander.mergeState.conflicts': '有冲突',
    'agentCommander.mergeState.conflictsReason': '此 Pull Request 与其基础分支存在冲突。',
    'agentCommander.mergeState.unknown': 'GitHub 状态未知',
    'agentCommander.mergeState.checksFailing': '检查未通过',
    'agentCommander.mergeState.checksRunning': '检查运行中',
    'agentCommander.mergeState.blocked': '受阻',
    'agentCommander.mergeState.behindBase': '落后于基础分支',
    'agentCommander.mergeState.checksPassed': '检查已通过',

    // Inbox composer
    'agentCommander.composer.suggestionFooter': '↑↓ 移动 · Enter 选择',
    'agentCommander.composer.suggestionLabel': '收件箱事项',
    'agentCommander.composer.replyingTo': '回复',
    'agentCommander.composer.clearTarget': '清除回复对象',
    'agentCommander.composer.mentionHint': '输入 @ 选择你要回答的事项。',
    'agentCommander.composer.inputLabel': '回复 Commander',
    'agentCommander.composer.placeholderWithTarget': '你的回答',
    'agentCommander.composer.placeholder': '@ 一个事项，然后输入你的回答',
    'agentCommander.composer.sendTooltip': '发送（Enter）',
    'agentCommander.composer.sendLabel': '发送回复',

    // Inbox commands
    'agentCommander.inboxCommands.replyFailed': '无法发送回复',
    'agentCommander.inboxCommands.dismissTitle': '忽略此事项？',
    'agentCommander.inboxCommands.dismissMergeMessage':
        '将告知 Commander 你不会从收件箱合并此 Pull Request。Pull Request 本身仍保持打开。',
    'agentCommander.inboxCommands.dismissQuestionMessage':
        '将告知 Commander 你未作回答就忽略了此问题。',
    'agentCommander.inboxCommands.dismissFailed': '无法忽略此事项',
    'agentCommander.inboxCommands.mergeTitle': '合并 {{pullRequest}}？',
    'agentCommander.inboxCommands.mergeMessage':
        '将使用仓库首选的合并方式合并 Commander 已验证的提交 {{sha}}。如果有新提交进入，GitHub 会拒绝合并。',
    'agentCommander.inboxCommands.mergeFailed': '无法合并此 Pull Request',
    'agentCommander.inboxCommands.merged': '已合并 {{pullRequest}}',

    // Commander commands
    'agentCommander.commands.revealFailed': '无法在工作台中显示此会话',
    'agentCommander.commands.openSettingsFailed': '无法在工作台中打开设置',
    'agentCommander.commands.stopFailed': '无法停止 Agent Commander',
    'agentCommander.commands.stopAndClose': '停止并关闭',
    'agentCommander.commands.stopOutcome':
        '停止 Commander 会结束当前这一轮并关闭此窗口。它委派的任务会继续运行。',
    'agentCommander.commands.stopTurnTitle': '停止正在运行的这一轮？',
    'agentCommander.commands.stopTurnMessage':
        'Agent Commander 仍在工作。停止它会结束当前这一轮并关闭其窗口。它委派的任务会继续运行。',
    // Hand-over
    'agentCommander.handover.open': '转交',
    'agentCommander.handover.openEllipsis': '转交…',
    'agentCommander.handover.openTooltip':
        '把你自己的会话，或在 Caxri 之外开始的 Agent 对话，转交给 Commander',
    'agentCommander.handover.title': '转交给 Agent Commander',
    'agentCommander.handover.description':
        'Commander 会接管你选中的内容，并从每段 Agent 对话停下的地方继续。备注告诉它要做什么。',
    'agentCommander.handover.sourceLabel': '转交什么',
    'agentCommander.handover.sessionsTab': '会话',
    'agentCommander.handover.conversationsTab': 'Caxri 之外',
    'agentCommander.handover.searchSessions': '搜索会话或项目',
    'agentCommander.handover.searchConversations': '搜索对话或文件夹',
    'agentCommander.handover.loadingSessions': '正在加载会话…',
    'agentCommander.handover.loadingConversations':
        '正在查找 Claude Code、Codex 和 Grok Build 的对话…',
    'agentCommander.handover.loadFailed': '无法加载此列表。',
    'agentCommander.handover.noMatches': '没有符合搜索条件的结果。',
    'agentCommander.handover.noSessions': '所有会话都已交给 Commander。',
    'agentCommander.handover.noConversations': '在 Caxri 之外没有找到最近 30 天的 Agent 对话。',
    'agentCommander.handover.selectGroup': '全选 {{group}}',
    'agentCommander.handover.selectCandidate': '选择 {{title}}',
    'agentCommander.handover.addsProject': '会将此文件夹添加为项目',
    'agentCommander.handover.mayBeOpen': '可能在别处打开',
    'agentCommander.handover.mayBeOpenWarning':
        '你选中的某段对话在几分钟内仍有活动。如果它还在另一个终端里打开，两边会各自继续，形成分叉。',
    'agentCommander.handover.tooMany': '一次最多转交 {{max}} 个，请取消选择 {{excess}} 个后继续。',
    'agentCommander.handover.untitledConversation': '未命名对话',
    'agentCommander.handover.refusedReason': '未转交：{{reason}}',
    'agentCommander.handover.noteLabel': '给 Commander 的备注',
    'agentCommander.handover.notePlaceholder':
        '可选：Commander 要做什么，例如“完成迁移并提交 pull request”',
    'agentCommander.handover.takeBackHint': '在已转交的会话里输入内容会将其收回。',
    'agentCommander.handover.selectedCount': '已选 {{count}} 项',
    'agentCommander.handover.submit': '转交',
    'agentCommander.handover.submitting': '正在转交…',
    'agentCommander.handover.failed': '无法转交给 Agent Commander',
    'agentCommander.handover.noneAccepted': '没有转交任何内容：{{reason}}',
    'agentCommander.handover.partlyAccepted':
        '已转交 {{accepted}} 项给 Agent Commander，{{refused}} 项未能转交',
    'agentCommander.handover.acceptedOne': '已将 1 个会话转交给 Agent Commander',
    'agentCommander.handover.acceptedOther': '已将 {{count}} 个会话转交给 Agent Commander',
    'agentCommander.handover.takeBackFailed': '无法收回该会话',
    'agentCommander.handover.takenBack': '已从 Agent Commander 收回该会话',
    'agentCommander.handover.takenBackByInput': '已从 Agent Commander 收回“{{title}}”',
    'agentCommander.handover.takenBackByInputUntitled': '已从 Agent Commander 收回一个会话',
    'agentCommander.handover.rejection.alreadyManaged': 'Commander 已在管理它',
    'agentCommander.handover.rejection.commanderSession': '它就是 Commander 自己',
    'agentCommander.handover.rejection.commanderUnavailable': 'Agent Commander 尚未设置',
    'agentCommander.handover.rejection.conversationBound': '已有 Caxri 终端绑定了这段对话',
    'agentCommander.handover.rejection.conversationMissing': '对话或其文件夹已不存在',
    'agentCommander.handover.rejection.duplicate': '重复选择',
    'agentCommander.handover.rejection.ownershipCapacity': 'Commander 管理的会话过多',
    'agentCommander.handover.rejection.projectUnavailable': '其项目已隐藏或不可用',
    'agentCommander.handover.rejection.sessionArchived': '会话已归档',
    'agentCommander.handover.rejection.sessionMissing': '会话已不存在',
    'agentCommander.handover.rejection.taskCapacity': 'Commander 未完成的任务过多',
    'agentCommander.board.handoverContinuable':
        '由你转交。待其 Agent 处于两轮之间时，Commander 会继续这段对话。',
    'agentCommander.board.handoverOwnershipOnly':
        '由你转交。这里没有可继续的 Agent 对话，Commander 会在这里开始新的工作。',

    // Workbench Session row marker
    'agentCommander.sessionMarker.managed': '由 Agent Commander 管理',
    'agentCommander.sessionMarker.inputTakesBack': '由 Agent Commander 管理 · 在这里输入会将其收回',
};

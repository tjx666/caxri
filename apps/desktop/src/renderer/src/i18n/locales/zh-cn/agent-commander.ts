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
        '暂无 Commander 任务。向 Commander 描述一个目标，它启动的会话会显示在这里。',
    'agentCommander.board.emptyAll': '暂无会话。所有项目的会话会在其 Agent 工作时显示在这里。',
    'agentCommander.board.scopeLabel': '看板范围',
    'agentCommander.board.scopeCommander': 'Commander',
    'agentCommander.board.scopeCommanderLabel': 'Commander 启动的会话',
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
    'agentCommander.task.label.takenOver': '已由你接管',
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
    'agentCommander.inbox.kind.hands': '需要你亲自操作',
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
};

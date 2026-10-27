import type { TranslatedNamespace } from '@caxri/protocol';

import type { desktop as source } from '../en/desktop';

export const desktop: TranslatedNamespace<typeof source> = {
    'desktop.menu.project': '项目',
    'desktop.menu.session': '会话',
    'desktop.menu.terminal': '终端',
    'desktop.menu.edit': '编辑',
    'desktop.menu.view': '显示',
    'desktop.menu.window': '窗口',
    'desktop.menu.help': '帮助',
    'desktop.menu.about': '关于 Caxri',
    'desktop.menu.hide': '隐藏 Caxri',
    'desktop.menu.hideOthers': '隐藏其他',
    'desktop.menu.showAll': '全部显示',
    'desktop.menu.quit': '退出 Caxri',
    'desktop.menu.undo': '撤销',
    'desktop.menu.redo': '重做',
    'desktop.menu.cut': '剪切',
    'desktop.menu.copy': '拷贝',
    'desktop.menu.paste': '粘贴',
    'desktop.menu.selectAll': '全选',
    'desktop.menu.reload': '重新载入',
    'desktop.menu.toggleDevTools': '切换开发者工具',
    'desktop.menu.minimize': '最小化',
    'desktop.menu.zoom': '缩放',
    'desktop.menu.bringAllToFront': '前置全部窗口',

    'desktop.dialog.cancel': '取消',
    'desktop.dialog.ok': '好',
    'desktop.dialog.open': '打开',

    'desktop.externalLink.title': '打开外部链接',
    'desktop.externalLink.message': '要在默认浏览器中打开 {{host}} 吗？',
    'desktop.externalLink.openOnce': '仅打开一次',
    'desktop.externalLink.trustDomain': '信任该域名并打开',
    'desktop.externalLink.trustHost': '信任 {{host}} 并打开',
    'desktop.externalLink.trustParent': '信任 *.{{parent}} 并打开',
    'desktop.externalLink.detailOnce': '{{url}}\n\n你可以打开此链接一次。',
    'desktop.externalLink.detailTrust':
        '{{url}}\n\n你可以只打开此链接一次，也可以信任这个来源，以后的链接直接打开。已信任的来源可在设置中查看或移除。',
    'desktop.externalLink.detailTrustParent':
        '{{url}}\n\n信任 {{host}} 只涵盖这一个主机。信任 *.{{parent}} 会涵盖 {{parent}} 的所有子域名，包括你从未访问过的；如果这是共享托管域名，就意味着包括他人控制的网站。两条规则都可在设置中查看或移除。',

    'desktop.trash.title': '移到废纸篓',
    'desktop.trash.message': '要将“{{name}}”移到废纸篓吗？',
    'desktop.trash.detail': '{{path}}\n\n你可以从废纸篓中恢复此项目。',
    'desktop.trash.detailUnsaved':
        '{{path}}\n\n此文件在编辑器中有未保存的更改。从废纸篓只能恢复最后一次保存的版本。',
    'desktop.trash.detailSshHost':
        '{{path}}\n\n此项目会移到 SSH Host {{host}} 的废纸篓，之后可以从那里恢复。',
    'desktop.trash.detailSshHostUnsaved':
        '{{path}}\n\n此项目会移到 SSH Host {{host}} 的废纸篓。此文件在编辑器中有未保存的更改，只能恢复最后一次保存的版本。',
    'desktop.trash.confirm': '移到废纸篓',

    'desktop.shellCommand.installTitle': '安装“caxri”命令',
    'desktop.shellCommand.uninstallTitle': '卸载“caxri”命令',
    'desktop.shellCommand.installMessage': 'Caxri 将请求管理员权限来安装“caxri” Shell 命令。',
    'desktop.shellCommand.uninstallMessage': 'Caxri 将请求管理员权限来卸载“caxri” Shell 命令。',
    'desktop.shellCommand.installDetail': '{{path}} 将链接到此 Caxri 应用内的 caxri 启动器。',
    'desktop.shellCommand.uninstallDetail': '{{path}} 将被移除，Caxri 应用本身不受影响。',

    'desktop.runningWork.terminalOne': '{{count}} 个终端',
    'desktop.runningWork.terminalOther': '{{count}} 个终端',
    'desktop.runningWork.chatOne': '{{count}} 个对话',
    'desktop.runningWork.chatOther': '{{count}} 个对话',
    'desktop.runningWork.runningTerminalOne': '{{count}} 个正在运行的终端',
    'desktop.runningWork.runningTerminalOther': '{{count}} 个正在运行的终端',
    'desktop.runningWork.runningChatOne': '{{count}} 个正在运行的对话',
    'desktop.runningWork.runningChatOther': '{{count}} 个正在运行的对话',
    'desktop.runningWork.and': '{{first}}和 {{second}}',

    'desktop.deleteProject.title': '删除项目',
    'desktop.deleteProject.confirm': '删除项目',
    'desktop.deleteProject.detail':
        '只会删除 Caxri 的元数据和快照，项目文件夹及其中的文件不会被改动。',
    'desktop.deleteProject.worktreeOne': '1 个关联的 Worktree 项目会一并移除：{{names}}。',
    'desktop.deleteProject.worktreeOther':
        '{{count}} 个关联的 Worktree 项目会一并移除：{{names}}。',
    'desktop.deleteProject.worktreeMore': '{{names}}，以及另外 {{count}} 个',
    'desktop.deleteProject.provenanceOne':
        '它是会话采用该 Worktree 时由 Caxri 自动登记的，只能通过这种级联方式移除。仍在其中工作的会话会保留，其工作台根目录将恢复为所属项目的根目录。',
    'desktop.deleteProject.provenanceOther':
        '它们是会话采用 Worktree 时由 Caxri 自动登记的，只能通过这种级联方式移除。仍在其中任一 Worktree 工作的会话会保留，其工作台根目录将恢复为所属项目的根目录。',
    'desktop.deleteSession.title': '删除会话',
    'desktop.deleteSession.confirm': '删除会话',
    'desktop.deleteSession.detail':
        '只会删除 Caxri 的元数据和快照，所选文件夹及其中的文件不会被改动。',
    'desktop.delete.message': '要删除“{{title}}”吗？',
    'desktop.delete.messageRunning': '要删除“{{title}}”并终止 {{running}}吗？',
    'desktop.deleteSessions.title': '删除会话',
    'desktop.deleteSessions.confirm': '删除会话',
    'desktop.deleteSessions.message': '要删除 {{count}} 个会话吗？',
    'desktop.deleteSessions.messageRunning': '要删除 {{count}} 个会话并终止 {{running}}吗？',
    'desktop.deleteSessions.detail':
        '只会删除 Caxri 的元数据和快照，所选文件夹及其中的文件不会被改动。',

    'desktop.clearBotData.title': '清除 Caxri Bot 数据',
    'desktop.clearBotData.message': '要清除所选的 Caxri Bot 数据吗？',
    'desktop.clearBotData.allTasks': '任务台账中的全部任务',
    'desktop.clearBotData.closedTasks': '任务台账中全部已结束的任务',
    'desktop.clearBotData.someTasks': '任务台账中的 {{count}} 个任务',
    'desktop.clearBotData.someTasksOne': '任务台账中的 1 个任务',
    'desktop.clearBotData.taskFiles': '任务说明和拉取请求报告',
    'desktop.clearBotData.inbox': '全部“需要你处理”事项及回复',
    'desktop.clearBotData.memory': '长期记忆，恢复为初始笔记，并据此重新生成 AGENTS.md',
    'desktop.clearBotData.instructions': 'AGENTS.md，按内置指令重新生成',
    'desktop.clearBotData.conversation': '当前对话；Caxri Bot 将重新开始',
    'desktop.clearBotData.detail': '此操作无法撤销。项目、会话以及其中正在运行的工作不受影响。',
    'desktop.clearBotData.confirm': '清除数据',

    'desktop.revokeDevice.title': '撤销移动设备',
    'desktop.revokeDevice.message': '要撤销“{{name}}”吗？',
    'desktop.revokeDevice.detail':
        '这台 {{platform}} 设备将立即失去对 Caxri 的访问权限。要重新连接，必须再次配对。项目和文件不受影响。',
    'desktop.revokeDevice.confirm': '撤销设备',

    'desktop.discard.title': '放弃更改',
    'desktop.discard.deleteMessage': '要删除“{{path}}”吗？',
    'desktop.discard.message': '要放弃“{{path}}”中的更改吗？',
    'desktop.discard.untrackedDetail': '此文件未被跟踪，将被永久删除且无法恢复。',
    'desktop.discard.trackedDetail': '文件将恢复到最后一次提交的状态，未提交的更改无法恢复。',
    'desktop.discard.deleteFile': '删除文件',
    'desktop.discard.confirm': '放弃更改',
    'desktop.discardAll.title': '放弃所有更改',
    'desktop.discardAll.messageOne': '要放弃“{{repository}}”中 1 个文件的所有更改吗？',
    'desktop.discardAll.messageOther': '要放弃“{{repository}}”中 {{count}} 个文件的所有更改吗？',
    'desktop.discardAll.detail':
        '已跟踪的文件将恢复到最后一次提交的状态，未跟踪的文件将被永久删除。未提交的更改无法恢复。',
    'desktop.discardAll.confirm': '放弃所有更改',

    'desktop.unsaved.title': '未保存的更改',
    'desktop.unsaved.message': '要保存对“{{name}}”所做的更改吗？',
    'desktop.unsaved.detail': '如果不保存，你的更改将会丢失。',
    'desktop.unsaved.save': '保存',
    'desktop.unsaved.dontSave': '不保存',
    'desktop.unsaved.saveAll': '全部保存',
    'desktop.unsaved.quitOne': '退出前要保存对“{{name}}”所做的更改吗？',
    'desktop.unsaved.quitOther': '退出前要保存对 {{count}} 个文件所做的更改吗？',
    'desktop.unsaved.closeOne': '关闭窗口前要保存对“{{name}}”所做的更改吗？',
    'desktop.unsaved.closeOther': '关闭窗口前要保存对 {{count}} 个文件所做的更改吗？',
    'desktop.unsaved.more': '以及另外 {{count}} 个',

    'desktop.revertFiles.title': '还原文件更改',
    'desktop.revertFiles.messageOne': '要还原 {{provider}} 在这一轮中更改的文件吗？',
    'desktop.revertFiles.messageOther': '要还原 {{provider}} 在这 {{count}} 轮中更改的文件吗？',
    'desktop.revertFiles.detail':
        '文件将回到这条消息之前的状态。之后对它们所做的更改（包括你自己的）都会丢失。',
    'desktop.revertFiles.confirm': '还原文件',
    'desktop.revertFiles.previewFailed': '无法预览更改，待还原的文件未列出。',
    'desktop.revertFiles.moreFiles': '……另有 {{count}} 个',
    'desktop.revertFiles.filesOne': '将还原 {{count}} 个文件',
    'desktop.revertFiles.filesOther': '将还原 {{count}} 个文件',

    'desktop.quit.title': '退出 Caxri？',
    'desktop.quit.messageOne': '有 {{running}}正在运行，要退出 Caxri 吗？',
    'desktop.quit.messageOther': '有 {{running}}正在运行，要退出 Caxri 吗？',
    'desktop.quit.detail':
        '“退出并停止任务”会结束所有正在运行的终端和 Agent 进程，释放 Agent 对话以便在其他工具中恢复，并停止 Caxri Server。“退出但保持任务运行”会让它们在后台继续挂接在 Caxri 上。',
    'desktop.quit.otherClientsOne': '另有 1 个客户端连接着 Caxri Server，停止后它将断开连接。',
    'desktop.quit.otherClientsOther':
        '另有 {{count}} 个客户端连接着 Caxri Server，停止后它们将断开连接。',
    'desktop.quit.stopTasks': '退出并停止任务',
    'desktop.quit.keepTasks': '退出但保持任务运行',
    'desktop.quit.reviewTitle': '有待发送的评审评论，仍要退出吗？',
    'desktop.quit.reviewMessageOne': '退出 Caxri 将丢失 1 条待发送的评审评论，确定吗？',
    'desktop.quit.reviewMessageOther': '退出 Caxri 将丢失 {{count}} 条待发送的评审评论，确定吗？',
    'desktop.quit.reviewDetailOne':
        '评审评论只保存在内存中，退出 Caxri 后不会保留。有 1 个仓库存在未发送的评论。',
    'desktop.quit.reviewDetailOther':
        '评审评论只保存在内存中，退出 Caxri 后不会保留。有 {{count}} 个仓库存在未发送的评论。',
    'desktop.quit.reviewLossOne': '退出还会丢失 1 条未发送的评审评论，因为评审评论只保存在内存中。',
    'desktop.quit.reviewLossOther':
        '退出还会丢失 {{count}} 条未发送的评审评论，因为评审评论只保存在内存中。',
    'desktop.quit.anyway': '仍要退出',
    'desktop.quit.stopFailureTitle': 'Caxri 未能停止所有任务',
    'desktop.quit.stopFailureMessage': '部分后台任务可能仍在运行。',
    'desktop.quit.stopFailureDetail':
        'Caxri 即将退出。请重新打开 Caxri 停止剩余任务，再在其他工具中恢复它们的 Agent 对话。',

    'desktop.windowClose.title': '关闭此窗口？',
    'desktop.windowClose.messageOne': '有 {{running}}正在运行，要关闭此窗口吗？',
    'desktop.windowClose.messageOther': '有 {{running}}正在运行，要关闭此窗口吗？',
    'desktop.windowClose.detail':
        '“保持运行”会关闭此窗口，并让它们在后台继续运行。要退出应用，请使用“退出 Caxri”并选择是否停止它们。',
    'desktop.windowClose.keepRunning': '保持运行',
    'desktop.windowClose.terminate': '终止并关闭',

    'desktop.crash.title': 'Caxri 反复崩溃',
    'desktop.crash.message': 'Caxri 窗口多次崩溃，已停止自动重新载入。',
    'desktop.crash.detail': '重新启动 Caxri，或退出以排查问题。',
    'desktop.crash.relaunch': '重新启动',
    'desktop.crash.revealLogs': '在访达中显示日志',
    'desktop.crash.quit': '退出',

    'desktop.chooseSession.title': '选择会话',
    'desktop.chooseSession.message': '在 {{project}} 中选择一个会话来打开此文件',
    'desktop.chooseSession.detail': '文件将在所选会话中打开，不会启动终端。',
    'desktop.chooseSession.untitled': '未命名',
    'desktop.chooseSession.fallbackProject': '项目',
    'desktop.externalFile.title': '打开已添加项目之外的文件？',
    'desktop.externalFile.message': '要打开项目之外的 {{name}} 吗？',
    'desktop.externalFile.detail':
        '{{path}}\n\n此文件不在任何已添加的项目中。Caxri 会在编辑器中打开它而不添加项目，保存时会写回此文件。信任该文件夹后，打开 {{folder}} 下的文件将不再提示。',
    'desktop.externalFile.trustFolder': '信任文件夹并打开',
    'desktop.themeImport.title': '导入主题',
    'desktop.themeImport.themeFiles': '主题文件',
    'desktop.fileFilter.allFiles': '所有文件',
    'desktop.diagnosticsExport.title': '导出诊断信息',
    'desktop.untitledSave.title': '另存为',
    'desktop.diagnosticsExport.zipArchive': 'ZIP 压缩包',
    'desktop.benchmarkShare.title': '保存分享图片',
    'desktop.benchmarkShare.pngImage': 'PNG 图片',
    'desktop.chooseProjectFolder': '选择项目文件夹',
    'desktop.chooseChatFilesAndFolders': '添加文件和文件夹',

    'desktop.fallback.thisProject': '此项目',
    'desktop.fallback.thisSession': '此会话',

    'desktop.notification.agentWaiting': '正在等待你的输入',
    'desktop.notification.agentTurnFinished': '本轮已完成',
    'desktop.notification.agentFinishedIn': '已完成，用时 {{duration}}',
    'desktop.notification.botInbox.title': 'Caxri Bot 需要你处理',
    'desktop.notification.botInbox.bodyOther': '收件箱中有 {{count}} 项新事项',

    'desktop.reset.title': '此版本的 Caxri 无法使用现有数据',
    'desktop.reset.message': '此版本的 Caxri 无法使用其他版本遗留的后台服务或数据。',
    'desktop.reset.detail':
        '请退出 Caxri，把 Caxri 数据文件夹移到废纸篓，然后重新打开 Caxri。你的项目文件夹和文件不会受到影响。',
    'desktop.reset.revealData': '显示数据文件夹',
    'desktop.reset.quit': '退出',

    'desktop.startupFailed.title': 'Caxri 无法启动后台服务',
    'desktop.startupFailed.message': 'Caxri 无法启动后台服务。',
    'desktop.startupFailed.detail.timeout': '服务启动用时过长。请重试；如果反复出现，请查看日志。',
    'desktop.startupFailed.detail.crashedOnBoot':
        '服务在启动后立即停止。请重试；如果反复出现，请查看日志。',
    'desktop.startupFailed.detail.database':
        '服务无法打开 Caxri 的数据。请先查看日志了解详情，再重试。',
    'desktop.startupFailed.detail.unknown': '请重试；如果反复出现，请查看日志。',
    'desktop.startupFailed.retry': '重试',
    'desktop.startupFailed.revealLogs': '在访达中显示日志',
    'desktop.startupFailed.quit': '退出',

    'desktop.runtimeFailed.title': 'Caxri 已停止',
    'desktop.runtimeFailed.message': 'Caxri 意外停止，且无法自行恢复。',
    'desktop.runtimeFailed.detail': '重新启动 Caxri 即可继续。你的项目和会话都会保留。',
    'desktop.runtimeFailed.relaunch': '重新启动 Caxri',
    'desktop.runtimeFailed.revealLogs': '在访达中显示日志',
    'desktop.runtimeFailed.quit': '退出',

    'desktop.moveToApplications.message': '要将 Caxri 移到“应用程序”文件夹吗？',
    'desktop.moveToApplications.detail':
        'Caxri 目前从下载文件夹或磁盘映像中运行。移到“应用程序”后可以自行更新，推出磁盘映像后也能继续使用。',
    'desktop.moveToApplications.move': '移到“应用程序”',
    'desktop.moveToApplications.notNow': '暂不',
    'desktop.serverReplaced.title': 'Caxri 已更新',
    'desktop.serverReplaced.bodyOne': '上一版本中正在运行的 1 个终端已停止。',
    'desktop.serverReplaced.bodyOther': '上一版本中正在运行的 {{count}} 个终端已停止。',
    'desktop.duration.hoursMinutes': '{{hours}} 小时 {{minutes}} 分',
    'desktop.duration.hours': '{{hours}} 小时',
    'desktop.duration.minutesSeconds': '{{minutes}} 分 {{seconds}} 秒',
    'desktop.duration.minutes': '{{minutes}} 分钟',
    'desktop.duration.seconds': '{{seconds}} 秒',
};

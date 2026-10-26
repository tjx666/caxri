import type { TranslatedNamespace } from '@caxri/protocol';

import type { core as source } from '../en/core';

export const core: TranslatedNamespace<typeof source> = {
    'core.errorBoundary.title': '出现了问题',
    'core.errorBoundary.description': 'Caxri 遇到了意外错误。重新加载即可恢复你的项目和会话。',
    'core.errorBoundary.technicalDetails': '技术详细信息',
    'core.errorBoundary.copyDetails': '复制详细信息',
    'core.errorBoundary.reloadWithoutSession': '不打开此会话并重新加载',
    'core.errorBoundary.agentCommander.title': 'Agent Commander 已停止渲染',
    'core.errorBoundary.agentCommander.description':
        '重新加载 Agent Commander 以重新连接到它的终端。在此期间 Commander 会继续运行。',
    'core.errorBoundary.agentCommander.reload': '重新加载 Agent Commander',
    'core.errorBoundary.benchmark.title': 'Benchmark 已停止渲染',
    'core.errorBoundary.benchmark.description':
        '重新加载 Benchmark 以重新显示运行记录。已开始的运行会继续进行。',
    'core.errorBoundary.benchmark.reload': '重新加载 Benchmark',
    'core.errorBoundary.performanceMonitor.title': '性能监视器已停止渲染',
    'core.errorBoundary.performanceMonitor.description': '重新加载性能监视器以恢复实时读数。',
    'core.errorBoundary.performanceMonitor.reload': '重新加载性能监视器',
    'core.errorBoundary.processExplorer.title': '进程资源管理器已停止渲染',
    'core.errorBoundary.processExplorer.description': '重新加载进程资源管理器以恢复实时诊断。',
    'core.errorBoundary.processExplorer.reload': '重新加载进程资源管理器',

    'core.copy.failed': '复制失败',
    'core.copy.code': '复制代码',
    'core.copy.table': '复制表格',
    'core.copy.quote': '复制引用',
    'core.copy.diagramSource': '复制图表源码',

    'core.block.fullscreen': '全屏查看',
    'core.block.table': '表格',
    'core.block.diagram': '图表',

    'core.findBar.placeholder': '查找',
    'core.findBar.previousMatch': '上一个匹配项',
    'core.findBar.nextMatch': '下一个匹配项',
    'core.findBar.close': '关闭查找',

    'core.reportCard.notMeasured': '未测量',

    'core.codeView.enableWordWrap': '启用自动换行',
    'core.codeView.disableWordWrap': '停用自动换行',
    'core.codeView.plainText': '文本',
    'core.codeView.runInTerminal': '在终端中运行',
    'core.markdown.openFile': '打开 {{file}}',
    'core.markdown.taskDone': '已完成：',
    'core.markdown.taskTodo': '待办：',

    'core.spinner.loading': '加载中',
    'core.command.suggestions': '建议',

    'core.diffStat.labelOne': '新增 {{additions}} 行，删除 {{deletions}} 行',
    'core.diffStat.labelOther': '新增 {{additions}} 行，删除 {{deletions}} 行',

    'core.gitDecoration.description': 'Git：{{kind}}。',
    'core.gitDecoration.kind.added': '已添加',
    'core.gitDecoration.kind.conflicted': '有冲突',
    'core.gitDecoration.kind.deleted': '已删除',
    'core.gitDecoration.kind.modified': '已修改',
    'core.gitDecoration.kind.renamed': '已重命名',
    'core.gitDecoration.kind.untracked': '未跟踪',
    'core.gitDecoration.childRepo.nested': '嵌套的 Git 仓库。',
    'core.gitDecoration.childRepo.submodule': 'Git 子模块。',

    'core.externalLink.unsupportedProtocol': '只能打开 HTTP 和 HTTPS 链接',
    'core.externalLink.credentialsNotAllowed': '外部链接不能包含凭据',
    'core.externalLink.invalid': '外部链接无效',
    'core.externalLink.openFailed': '无法打开外部链接',

    'core.documentRead.failed': '无法打开此文件',
    'core.documentRead.interrupted': '打开此文件的过程被中断。',

    'core.contextMenu.showFailed': '无法显示菜单',

    'core.files.copyPathFailed': '无法复制路径',
    'core.files.pathOutsideProject': '路径不在所选项目内',
    'core.files.relativePathCopied': '已复制相对路径',
    'core.files.pathCopied': '已复制路径',
    'core.files.nameCopied': '已复制文件名',
    'core.files.noSessionSelected': '未选择会话',
    'core.files.revealFailed': '无法在访达中显示该项目',
    'core.files.openWithDefaultAppFailed': '无法使用默认应用打开该项目',

    'core.workbench.layoutSaveFailed': '无法保存会话布局',
    'core.workbench.profileTakenOver': '另一个 Caxri 窗口已接管此配置。请在另一个窗口中继续。',
    'core.workbench.snapshotLoadFailed': '无法从 Server 加载项目和会话',
    'core.workbench.snapshotRefreshFailed': '无法从 Server 刷新项目和会话',

    'core.configurationErrors.multiple':
        '{{count}} 个配置文件有错误，已改用默认值。首个错误：{{first}}',
    'core.workbenchRoot.fallback': '当前 Worktree 已不可用。已返回到 {{title}}。',
    'core.workbenchRoot.followedNamed': '已切换到 Worktree“{{title}}”：有 Agent 移动到了那里。',
    'core.workbenchRoot.followed': '已切换到另一个 Worktree：有 Agent 移动到了那里。',
    'core.workbenchRoot.undoNamed': '撤销切换到 Worktree {{title}}',
    'core.workbenchRoot.undo': '撤销切换到另一个 Worktree',
    'core.workbenchRoot.undoFailed': '无法返回之前的工作台根目录',

    'core.automaticNaming.sandboxBoundaryConflict':
        '{{subject}}：项目沙箱边界阻止了自动命名。请选择更具体的项目文件夹，然后重启 Agent。',
    'core.automaticNaming.sandboxUnavailable':
        '{{subject}}：自动命名需要这台机器安装 bubblewrap（bwrap）。安装后请重启 Agent。',
    'core.automaticNaming.unverifiedPaths':
        '{{subject}}：无法验证沙箱路径，自动命名不可用。请更正路径后重启 Agent。',

    'core.agentNotification.waiting': '{{title}} 正在等待你的输入。',
    'core.agentNotification.completed': '{{title}} 已完成一轮对话。',
    'core.projectStatusAlert.checkFailed': 'CI 失败：{{name}}',
    'core.projectStatusAlert.deploymentFailed': '{{name}} 部署失败',

    'core.commands.usageNeedsProject': '添加项目后才能打开用量',
    'core.commands.openBenchmarkFailed': '无法打开 Benchmark',
    'core.commands.openAgentCommanderFailed': '无法打开 Agent Commander',
    'core.commands.diagnosticsExportFailed': '诊断信息导出失败',
    'core.commands.diagnosticsExported': '诊断信息已导出到 {{path}}',
    'core.commands.revealExportFailed': '无法在访达中显示诊断文件',
    'core.commands.revealLogsFailed': '无法在访达中显示日志文件夹',

    'core.usageFormat.lessThanMinute': '<1 分钟',
    'core.usageFormat.minutes': '{{minutes}} 分钟',
    'core.usageFormat.hours': '{{hours}} 小时',
    'core.usageFormat.hoursMinutes': '{{hours}} 小时 {{minutes}} 分钟',
    'core.usageFormat.window.weekly': '每周',
    'core.usageFormat.window.days': '{{count}} 天',
    'core.usageFormat.window.hours': '{{count}} 小时',
    'core.usageFormat.window.minutes': '{{count}} 分钟',
    'core.usageFormat.shortWindow.weekly': '本周',
    'core.usageFormat.shortWindow.days': '{{count}} 天',
    'core.usageFormat.shortWindow.hours': '{{count}} 小时',
    'core.usageFormat.shortWindow.minutes': '{{count}} 分钟',
    'core.usageFormat.resetsNow': '即将重置',
    'core.usageFormat.resetsInDays': '{{days}} 天 {{hours}} 小时后重置',
    'core.usageFormat.resetsIn': '{{duration}}后重置',
};

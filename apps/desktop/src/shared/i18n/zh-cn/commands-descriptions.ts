import type { commandDescriptions as source } from '../en/commands-descriptions';
import type { TranslatedNamespace } from '../translated-namespace';

export const commandDescriptions: TranslatedNamespace<typeof source> = {
    'commands.description.project.create': '将一个文件夹添加为项目',
    'commands.description.project.delete': '从 Caxri 中删除所选项目，不会改动其中的文件',
    'commands.description.project.hide': '隐藏所选项目并保留其会话；再次添加同一文件夹即可恢复',
    'commands.description.project.openInEditor': '在配置的外部编辑器中打开所选项目的根目录',
    'commands.description.project.customizeIcon': '为所选项目选择图标和颜色',
    'commands.description.session.create': '在所选项目中新建会话',
    'commands.description.session.rename': '在主侧边栏中重命名所选会话',
    'commands.description.session.renameWithAi':
        '根据所选会话的 Agent 对话建议一个名称，可直接采用或编辑',
    'commands.description.session.delete': '删除所选会话及其终端，不会改动磁盘上的文件',
    'commands.description.session.archive': '将所选会话移出侧边栏并暂存其终端',
    'commands.description.session.compactWarm':
        '趁压缩成本仍低时，压缩最近进入空闲的会话中的 Agent 对话',
    'commands.description.session.detach': '停止所选会话的 Agent 终端，以便其他客户端恢复同一对话',
    'commands.description.session.resume': '重新启动所选会话中已分离的 Agent 终端并恢复其对话',
    'commands.description.session.openPullRequest':
        '在浏览器中打开所选会话在 GitHub 上的 Pull Request',
    'commands.description.session.selectNext': '选择下一个活跃会话',
    'commands.description.session.selectPrevious': '选择上一个活跃会话',
    'commands.description.session.switchMru': '按最近使用顺序在活跃会话之间切换',
    'commands.description.session.focusNextAttention': '选择下一个有未查看事件的会话',
    'commands.description.session.navigateBack': '返回到之前查看的会话',
    'commands.description.session.navigateForward': '前进到刚才后退离开的会话',
    'commands.description.session.searchContent': '按用户和助手消息查找活跃及已归档的会话',
    'commands.description.session.openArchived': '打开已归档会话管理器，恢复或删除暂存的会话',
    'commands.description.agentActions.open': '为当前 Agent 终端搜索 Agent 命令和 Skill',
    'commands.description.terminal.new': '在当前会话中新建终端',
    'commands.description.terminal.newInSplit': '在当前窗格右侧的新窗格中新建终端',
    'commands.description.terminal.clear': '清除当前终端的视图',
    'commands.description.terminal.copy': '将当前终端中的所选内容复制到剪贴板',
    'commands.description.terminal.find': '搜索当前终端的缓冲区',
    'commands.description.terminal.openDetectedLink': '无需鼠标即可搜索并打开终端中检测到的链接',
    'commands.description.terminal.previousCommand': '将当前终端滚动到上一条命令的边界',
    'commands.description.terminal.nextCommand': '将当前终端滚动到下一条命令的边界',
    'commands.description.workbench.action.terminal.sendSequence': '将配置的文本直接发送到当前终端',
    'commands.description.terminal.restart': '重启当前 Shell，或重启当前 Agent 并恢复其对话',
    'commands.description.terminal.startNewAgentSession':
        '以新对话重启当前 Agent，而不是恢复当前对话',
    'commands.description.terminal.switchAgentSurface':
        '将当前 Agent 以对话方式重新打开，或将对话以终端方式重新打开，并延续其对话',
    'commands.description.terminal.showAgentStatus':
        '打开当前 Agent 的输出速度及其提供商的服务状态',
    'commands.description.terminal.close': '关闭当前终端',
    'commands.description.workbench.closeActiveTab': '关闭当前终端或文件标签页',
    'commands.description.workbench.nextTab': '激活下一个终端或文件标签页',
    'commands.description.workbench.previousTab': '激活上一个终端或文件标签页',
    'commands.description.editor.save': '保存当前文件',
    'commands.description.editor.sendReferenceToTerminal':
        '将当前文件路径和光标所在行（`@path#L12`）输入到最近打开的终端',
    'commands.description.editor.addReviewComment': '为 Git 差异中的所选行添加批注',
    'commands.description.editor.openPreview': '以渲染预览显示当前 Markdown 或 SVG 文件',
    'commands.description.editor.openPreviewToSide':
        '在源文件旁以渲染预览显示当前 Markdown 或 SVG 文件',
    'commands.description.editor.openImportLink': '打开编辑器光标处导入路径所指向的文件',
    'commands.description.workbench.splitLeft': '将当前标签页拆分到左侧的新窗格',
    'commands.description.workbench.splitRight': '将当前标签页拆分到右侧的新窗格',
    'commands.description.workbench.splitUp': '将当前标签页拆分到上方的新窗格',
    'commands.description.workbench.splitDown': '将当前标签页拆分到下方的新窗格',
    'commands.description.workbench.focusPaneLeft': '将键盘焦点移到当前窗格左侧的窗格',
    'commands.description.workbench.focusPaneRight': '将键盘焦点移到当前窗格右侧的窗格',
    'commands.description.workbench.focusPaneUp': '将键盘焦点移到当前窗格上方的窗格',
    'commands.description.workbench.focusPaneDown': '将键盘焦点移到当前窗格下方的窗格',
    'commands.description.workbench.moveActiveTerminalToNewSession':
        '将当前终端移到其所属项目中的一个新会话',
    'commands.description.workbench.selectRoot':
        '让文件、编辑器和 Git 指向另一个项目根目录或关联的 Worktree',
    'commands.description.secondarySidebar.showFiles': '在辅助侧边栏中显示文件',
    'commands.description.secondarySidebar.searchFiles': '在所选项目中搜索文件',
    'commands.description.secondarySidebar.showGit': '在辅助侧边栏中显示源代码管理',
    'commands.description.secondarySidebar.showStatus': '在辅助侧边栏中显示项目状态',
    'commands.description.secondarySidebar.toggle': '显示或隐藏辅助侧边栏',
    'commands.description.panel.showLogs': '在面板中显示日志',
    'commands.description.panel.showInfo': '在面板中显示信息',
    'commands.description.panel.toggle': '显示或隐藏面板',
    'commands.description.primarySidebar.toggle': '显示或隐藏主侧边栏',
    'commands.description.primarySidebar.toggleActivity':
        '在项目树与按待处理程度分组的所有项目 Agent 会话之间切换主侧边栏',
    'commands.description.primarySidebar.focus': '将键盘焦点移入主侧边栏，若已隐藏则先显示',
    'commands.description.view.zoomIn': '将整个界面放大一级',
    'commands.description.view.zoomOut': '将整个界面缩小一级',
    'commands.description.view.resetZoom': '将界面恢复为原始大小',
    'commands.description.usage.open': '显示 Caxri 会话的 Token 用量、预估费用和交付统计',
    'commands.description.settings.open': '打开 Caxri 设置',
    'commands.description.settings.openSource': '在 Caxri 源码编辑器中打开 settings.jsonc',
    'commands.description.settings.openKeybindings': '编辑 Caxri 快捷键',
    'commands.description.settings.openNotifications': '管理通知偏好并恢复已静音的提醒',
    'commands.description.settings.manageTrustedDomains':
        '查看 Caxri 无需确认即可打开的外部链接来源',
    'commands.description.updates.check': '检查是否有更新的 Caxri 版本',
    'commands.description.shellCommand.install':
        '将内置的 caxri CLI 链接到 /usr/local/bin，以便任何终端都能运行',
    'commands.description.shellCommand.uninstall': '移除指向 Caxri 应用包的 caxri 链接',
    'commands.description.pathBrowser.open': '浏览所选项目并打开文件',
    'commands.description.commandPalette.open': '搜索并运行 Caxri 命令',
    'commands.description.agentCommander.open': '打开 Commander Agent 旁的跨项目 Agent 看板',
    'commands.description.agentCommander.stop':
        '停止在后台运行的 Agent Commander；再次打开会恢复同一对话',
    'commands.description.processExplorer.open': '查看 Caxri 各进程的资源占用',
    'commands.description.developer.toggleScreencastMode': '显示点击和 Caxri 快捷键，便于外部录屏',
    'commands.description.developer.reportBug':
        '预览并向运行中的 Agent 发送一份保护隐私的本地问题报告',
    'commands.description.diagnostics.export': '导出一份保护隐私的诊断包',
    'commands.description.git.switchBranch': '在所选会话的仓库中检出另一个分支',
    'commands.description.git.goToNextReviewComment': '跳转到当前 Git 差异标签页中的下一条评审评论',
    'commands.description.git.goToPreviousReviewComment':
        '跳转到当前 Git 差异标签页中的上一条评审评论',
    'commands.description.git.showPendingReviewComments':
        '打开有待提交评审评论的仓库并定位到这些评论',
};

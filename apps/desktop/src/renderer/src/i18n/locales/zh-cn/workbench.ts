import type { TranslatedNamespace } from '@caxri/protocol';

import type { workbench as source } from '../en/workbench';

export const workbench: TranslatedNamespace<typeof source> = {
    'workbench.welcome.title': '以项目为中心的开发。',
    'workbench.welcome.description':
        '将一个文件夹添加为项目，然后把所有 Agent 和 Shell 会话集中放在它下面。',
    'workbench.welcome.addProject': '添加项目',
    'workbench.welcome.returningTitle': '从上次的地方继续。',
    'workbench.welcome.returningDescription':
        '在“{{project}}”中开始新的会话，或添加另一个文件夹作为项目。',
    'workbench.welcome.newSession': '在“{{project}}”中新建会话',
    'workbench.welcome.commandPalette': '命令面板',
    'workbench.welcome.keyboardShortcuts': '键盘快捷键',
    'workbench.welcome.documentation': '文档',
    'workbench.closeSettings': '关闭设置',
    'workbench.resizePanel': '调整面板大小',
    'workbench.resizePrimarySidebar': '调整主侧边栏大小',
    'workbench.resizeSecondarySidebar': '调整辅助侧边栏大小',

    'workbench.pane.empty': '此会话中没有终端。',
    'workbench.pane.tabListLabel': '窗格 {{index}}/{{count}} 中打开的标签页',
    'workbench.pane.resizeHorizontalSplit': '调整水平拆分大小',
    'workbench.pane.resizeVerticalSplit': '调整垂直拆分大小',
    'workbench.pane.dropZone.center': '移到此窗格',
    'workbench.pane.dropZone.left': '向左拆分',
    'workbench.pane.dropZone.right': '向右拆分',
    'workbench.pane.dropZone.up': '向上拆分',
    'workbench.pane.dropZone.down': '向下拆分',

    'workbench.tab.closeEditor': '关闭编辑器',
    'workbench.tab.closeTerminal': '关闭终端',
    'workbench.tab.compacting': '正在压缩上下文',
    'workbench.tab.compactingTooltip': 'Agent 正在总结之前的上下文，完成后继续。',

    'workbench.tabMenu.close.one': '关闭',
    'workbench.tabMenu.close.others': '关闭其他',
    'workbench.tabMenu.close.right': '关闭右侧',
    'workbench.tabMenu.close.editors': '关闭编辑器',
    'workbench.tabMenu.close.all': '全部关闭',
    'workbench.tabMenu.split.left': '向左拆分',
    'workbench.tabMenu.split.right': '向右拆分',
    'workbench.tabMenu.split.up': '向上拆分',
    'workbench.tabMenu.split.down': '向下拆分',
    'workbench.tabMenu.splitBlocked.missing': '此标签页已不再打开',
    'workbench.tabMenu.splitBlocked.onlyTab': '请先在此窗格中打开另一个标签页',
    'workbench.tabMenu.splitBlocked.paneLimit': '一个工作台最多容纳 {{count}} 个窗格',

    'workbench.rootPrompt.label': '新的 Git Worktree',
    'workbench.rootPrompt.message': '已为此会话创建新的 Git Worktree。',
    'workbench.rootPrompt.focusHint': '按 Shift+Escape 聚焦到此通知。',
    'workbench.rootPrompt.notNow': '暂不',
    'workbench.rootPrompt.continue': '在 Worktree 中继续会话',
    'workbench.rootPrompt.continueFailed': '无法在 Worktree 中继续',
    'workbench.rootPrompt.dismissFailed': '无法忽略 Worktree 建议',
};

import type { TranslatedNamespace } from '@caxri/protocol';

import type { keyboardShortcuts as source } from '../en/keyboard-shortcuts';

export const keyboardShortcuts: TranslatedNamespace<typeof source> = {
    'keyboardShortcuts.title': '键盘快捷键',
    'keyboardShortcuts.searchLabel': '搜索键盘快捷键',
    'keyboardShortcuts.searchPlaceholder': '搜索命令或快捷键',
    'keyboardShortcuts.extensionsCategory': '扩展',
    'keyboardShortcuts.noMatches': '没有与搜索匹配的快捷键。',
    'keyboardShortcuts.none': '还没有任何命令绑定快捷键。',
    'keyboardShortcuts.editKeybindings': '编辑快捷键',
    'keyboardShortcuts.pinnedRange': '切换到第 1 至 9 个置顶会话',
    'keyboardShortcuts.sidebar.category': '会话列表',
    'keyboardShortcuts.sidebar.move': '在行之间移动',
    'keyboardShortcuts.sidebar.collapse': '折叠项目',
    'keyboardShortcuts.sidebar.expand': '展开项目',
    'keyboardShortcuts.sidebar.archive': '归档会话',
};

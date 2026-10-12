import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { settingsKeybindings as source } from '../en/settings-keybindings';

export const settingsKeybindings: TranslatedNamespace<typeof source> = {
    'settings.keybindingEditor.customCategory': '自定义',
    'settings.keybindingEditor.searchLabel': '搜索快捷键',
    'settings.keybindingEditor.searchPlaceholder': '搜索命令或快捷键',
    'settings.keybindingEditor.clearSearch': '清除搜索',
    'settings.keybindingEditor.clearSearchLabel': '清除快捷键搜索',
    'settings.keybindingEditor.count': '{{visible}} / {{total}} 个快捷键',
    'settings.keybindingEditor.empty': '未找到快捷键。',
    'settings.keybindingEditor.neverFires': '永不触发：{{shortcut}} 会开始一个组合键序列',
    'settings.keybindingEditor.conflictsWith': '与 {{commands}} 冲突',
    'settings.keybindingEditor.editShortcutFor': '编辑“{{command}}”的快捷键',
    'settings.keybindingEditor.addShortcutFor': '为“{{command}}”添加快捷键',
    'settings.keybindingEditor.recordingHint': 'Enter 保存 · ⌫ 清除 · Esc 取消',
    'settings.keybindingEditor.pressShortcut': '按下快捷键 · Esc 取消',
    'settings.keybindingEditor.addShortcut': '添加快捷键',
    'settings.keybindingEditor.removeShortcutFor': '移除“{{command}}”的快捷键',
    'settings.keybindingEditor.resetShortcutFor': '重置“{{command}}”的快捷键',
};

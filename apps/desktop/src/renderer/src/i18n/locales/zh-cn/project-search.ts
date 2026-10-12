import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { projectSearch as source } from '../en/project-search';

export const projectSearch: TranslatedNamespace<typeof source> = {
    // Dialog chrome
    'projectSearch.dialog.title': '搜索文件',
    'projectSearch.dialog.helpMove': '↑↓ 移动',
    'projectSearch.dialog.helpOpen': 'Enter 打开',
    'projectSearch.dialog.helpOpenToSide': '⌘Enter 在侧边打开',
    'projectSearch.dialog.helpDoubleClick': '双击结果即可打开',
    // Result-pane messages
    'projectSearch.status.searching': '正在搜索…',
    'projectSearch.status.failed': '搜索失败。',
    'projectSearch.status.noResults': '无结果。',
    // Query controls
    'projectSearch.controls.findFilesLabel': '查找项目文件',
    'projectSearch.controls.searchContentsLabel': '搜索项目内容',
    'projectSearch.controls.findFilesPlaceholder': '查找文件',
    'projectSearch.controls.searchTextPlaceholder': '搜索文本',
    'projectSearch.controls.clearTooltip': '清除搜索',
    'projectSearch.controls.clearLabel': '清除项目搜索',
    'projectSearch.controls.matchCase': '区分大小写',
    'projectSearch.controls.matchWholeWord': '全字匹配',
    'projectSearch.controls.useRegex': '使用正则表达式',
    'projectSearch.controls.ignoreFilesOn': '正在遵循 .gitignore：点击以同时搜索被忽略的文件',
    'projectSearch.controls.ignoreFilesOff': '正在搜索被忽略的文件：点击以应用 .gitignore',
    'projectSearch.controls.useIgnoreFiles': '使用忽略文件',
    'projectSearch.controls.modeName': '名称',
    'projectSearch.controls.modeContent': '内容',
    'projectSearch.controls.include': '包含的文件',
    'projectSearch.controls.includePlaceholder': '包含的文件（例如 *.ts, src/**）',
    'projectSearch.controls.exclude': '排除的文件',
    'projectSearch.controls.excludePlaceholder': '排除的文件（例如 *.min.js, dist/**）',
    // Results and preview
    'projectSearch.results.label': '搜索结果',
    'projectSearch.preview.empty': '选择一个结果以预览。',
    'projectSearch.preview.readFailed': '无法读取此文件。',
    'projectSearch.preview.loading': '正在加载预览…',
    // Why a search ended early; `{{next}}` is one of the two follow-up sentences below
    'projectSearch.termination.canceled': '搜索已取消。',
    'projectSearch.termination.timeout': '扫描 {{count}} 个文件后搜索超时。{{next}}',
    'projectSearch.termination.fileLimit': '已达到 {{count}} 个文件的上限，搜索已停止。{{next}}',
    'projectSearch.termination.resultLimit': '搜索已达到结果数量上限。正在显示部分结果。',
    'projectSearch.termination.payloadLimit': '搜索已达到响应大小上限。正在显示部分结果。',
    'projectSearch.termination.showingPartial': '正在显示部分结果。',
    'projectSearch.termination.narrowSearch': '请缩小搜索范围后重试。',
};

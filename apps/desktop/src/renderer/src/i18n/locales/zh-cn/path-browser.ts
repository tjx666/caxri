import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { pathBrowser as source } from '../en/path-browser';

export const pathBrowser: TranslatedNamespace<typeof source> = {
    // Dialog chrome
    'pathBrowser.dialog.title': '按路径打开文件',
    'pathBrowser.projectRootFallback': '项目',
    // Query field
    'pathBrowser.query.parentDirectory': '上级目录',
    'pathBrowser.query.inputLabel': '文件路径',
    'pathBrowser.query.placeholderProject': '筛选，或输入 / 或 ~ 访问任意路径…',
    'pathBrowser.query.placeholderFree': '筛选，或输入 ./ 返回项目…',
    'pathBrowser.query.placeholderRemote': '筛选，或输入此项目中的路径…',
    'pathBrowser.query.anchorHelp':
        '输入以 / 或 ~ 开头的路径可浏览项目以外的位置，也可在输入框为空时于开头按 Backspace。输入 ./ 返回项目。',
    'pathBrowser.query.projectRootRemoved': '已移除项目根目录。可输入任意路径。',
    // Results list
    'pathBrowser.results.label': '文件',
    'pathBrowser.results.createFolder': '新建文件夹“{{name}}”',
    'pathBrowser.results.createFile': '新建文件“{{name}}”',
    'pathBrowser.results.createDestination': '位于 {{directory}}',
    'pathBrowser.results.directory': '目录',
    // Row groups and notices
    'pathBrowser.rows.directoryGroup': '当前文件夹',
    'pathBrowser.rows.projectGroup': '项目中的其他位置',
    'pathBrowser.rows.searchUnavailable': '项目搜索暂不可用。',
    'pathBrowser.rows.searchIncomplete': '仅搜索了项目的一部分。请细化名称。',
    'pathBrowser.rows.directoryTruncated':
        '仅显示了此文件夹的一部分。请细化名称或打开更具体的文件夹。',
    'pathBrowser.rows.noMatch': '没有匹配的文件或文件夹。',
    // Keyboard help footer
    'pathBrowser.help.select': '↑↓ 选择',
    'pathBrowser.help.complete': 'Tab 补全',
    'pathBrowser.help.create': 'Enter 新建',
    'pathBrowser.help.open': '→/Enter 打开',
    'pathBrowser.help.parent': '在开头按 ← 返回上级',
    'pathBrowser.help.anyPath': '/ 或 ~ 任意路径',
    'pathBrowser.help.returnToProject': './ 项目',
    'pathBrowser.help.close': 'Esc 关闭',
    // Status
    'pathBrowser.status.searching': '正在搜索…',
    'pathBrowser.status.loadingFolder': '正在加载文件夹…',
    // Errors
    'pathBrowser.errors.shellExpansion': '不支持 Shell 路径展开',
    'pathBrowser.errors.otherUserHome': '仅支持当前用户的 ~/ 路径',
    'pathBrowser.errors.invalidPath': '路径无效',
    'pathBrowser.errors.browseFailed': '无法浏览文件',
    'pathBrowser.errors.openFailed': '无法打开路径',
    'pathBrowser.errors.openExternalFailed': '无法在此会话中打开外部文件',
    'pathBrowser.errors.reopenFolderFailed': '无法重新打开已创建的文件夹',
    'pathBrowser.errors.createFolderFailed': '无法新建文件夹',
    'pathBrowser.errors.createFileFailed': '无法新建文件',
};

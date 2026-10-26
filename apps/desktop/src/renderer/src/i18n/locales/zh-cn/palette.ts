import type { TranslatedNamespace } from '@caxri/protocol';

import type { palette as source } from '../en/palette';

export const palette: TranslatedNamespace<typeof source> = {
    'palette.title': '命令面板',
    'palette.searchPlaceholder': '搜索项目、会话和命令…',
    'palette.empty': '未找到项目、会话或命令。',
    'palette.group.recent': '最近使用',
    'palette.footer.navigate': '选择',
    'palette.footer.run': '执行',
    'palette.footer.close': '关闭',
    'palette.group.projects': '项目',
    'palette.group.sessions': '会话',
    'palette.group.commands': '命令',
    'palette.source.project': '项目',
    'palette.source.session': '会话',
    'palette.source.extension': '扩展',
};

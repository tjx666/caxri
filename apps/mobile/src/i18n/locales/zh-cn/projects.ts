import type { TranslatedNamespace } from '@caxri/protocol';

import type { projects as source } from '../en/projects';

export const projects: TranslatedNamespace<typeof source> = {
    'projects.add': '添加',
    'projects.addAsProject': '将 {{name}} 添加为项目',
    'projects.addCurrent': '添加“{{name}}”',
    'projects.addError': '无法添加此文件夹',
    'projects.adding': '正在添加…',
    'projects.footerHint': '打开文件夹后添加，或点按文件夹旁的“添加”。',
    'projects.gitRepositoryLabel': '{{name}}，Git 仓库',
    'projects.home': '主目录',
    'projects.listError': '无法列出此文件夹。',
    'projects.noFolders': '这里没有文件夹。',
    'projects.openFolderHint': '打开此文件夹。',
    'projects.title': '添加项目',
    'projects.truncated': '仅显示前 {{count}} 个文件夹。',
    'projects.upOneFolder': '返回上一级文件夹',
};

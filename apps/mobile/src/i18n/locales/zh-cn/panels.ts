import type { TranslatedNamespace } from '@caxri/protocol';

import type { panels as source } from '../en/panels';

export const panels: TranslatedNamespace<typeof source> = {
    'panels.backToFolder': '返回文件夹',
    'panels.discard': '放弃',
    'panels.discardChanges': '放弃更改',
    'panels.discardTitle': '放弃未保存的更改？',
    'panels.edit': '编辑',
    'panels.editFile': '编辑文件',
    'panels.entryBrokenLink': '{{name}}，文件，链接已失效',
    'panels.entryFile': '{{name}}，文件',
    'panels.entryFolder': '{{name}}，文件夹',
    'panels.fileContents': '文件内容',
    'panels.fileUnavailable': '此文件过大或不是文本。请在电脑上打开。',
    'panels.folderEmpty': '此文件夹为空。',
    'panels.keepEditing': '继续编辑',
    'panels.listFailed': '无法列出此文件夹的内容。',
    'panels.listTruncated': '仅显示前面的条目，其余请在电脑上打开。',
    'panels.loadFailed': '无法加载此视图。',
    'panels.offline': '重新连接以浏览此项目。',
    'panels.openFileFailed': '无法打开此文件。',
    'panels.openFolder': '打开 {{name}}',
    'panels.save': '保存',
    'panels.saveConflict': '此文件已在电脑上更改。请放弃并重新加载后再编辑。',
    'panels.saveFailed': '无法保存此文件，请重试。',
    'panels.saveFile': '保存文件',
    'panels.treeEmpty': '没有可显示的内容。',
    'panels.treeOtherSession': '在电脑上打开此会话以在这里查看其详情。',
    'panels.upOneFolder': '返回上一级文件夹',
    'panels.viewOnComputerOnly': '{{title}} 仅能在电脑上查看。',
    'panels.viewUnavailable': '此视图在手机上不可用。请选择其他标签页。',
};

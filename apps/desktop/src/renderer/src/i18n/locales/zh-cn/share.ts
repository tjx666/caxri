import type { TranslatedNamespace } from '@caxri/protocol';

import type { share as source } from '../en/share';

export const share: TranslatedNamespace<typeof source> = {
    'share.title': '发送到会话',
    'share.searchPlaceholder': '选择一个会话…',
    'share.empty': '未找到会话。',
    'share.receivedOne': '来自其他应用：{{name}}',
    'share.receivedMany': '来自其他应用：{{name}} 等 {{count}} 项',
    'share.receivedText': '来自其他应用的文本',
    'share.noTarget': '此会话没有可接收文件的 Agent 对话或终端',
    'share.terminalNotReady': '终端未就绪，未插入共享的文件',
};

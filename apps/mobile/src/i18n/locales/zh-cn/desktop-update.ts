import type { TranslatedNamespace } from '@caxri/protocol';

import type { desktopUpdate as source } from '../en/desktop-update';

export const desktopUpdate: TranslatedNamespace<typeof source> = {
    'desktopUpdate.availableDetail': '在你的电脑上下载，之后再确认重启。',
    'desktopUpdate.blocked.changed': '电脑上的更新已变化，请重新检查。',
    'desktopUpdate.blocked.unsavedOne':
        '电脑上有 1 个文件未保存。请先在电脑上保存或关闭它，然后重试。',
    'desktopUpdate.blocked.unsavedOther':
        '电脑上有 {{count}} 个文件未保存。请先在电脑上保存或关闭它们，然后重试。',
    'desktopUpdate.checkHint': '让你的电脑检查是否有更新的 Caxri。',
    'desktopUpdate.confirm.action': '重启并更新',
    'desktopUpdate.confirm.detail': '你电脑上的 Caxri 将重启到 {{version}} 版本。',
    'desktopUpdate.confirm.title': '重启电脑上的 Caxri？',
    'desktopUpdate.desktopClosed': '在电脑上打开 Caxri 后才能更新',
    'desktopUpdate.downloadFailed': '电脑上的下载没有完成。',
    'desktopUpdate.downloading': '电脑正在下载 {{version}}',
    'desktopUpdate.downloadingDetail': '正在下载…',
    'desktopUpdate.impact.and': '和',
    'desktopUpdate.impact.chatsOne': '1 个 Chat',
    'desktopUpdate.impact.chatsOther': '{{count}} 个 Chat',
    'desktopUpdate.impact.more': '另外 {{count}} 个',
    'desktopUpdate.impact.reviewCommentsOne': '1 条未发送的 review 评论会丢失。',
    'desktopUpdate.impact.reviewCommentsOther': '{{count}} 条未发送的 review 评论会丢失。',
    'desktopUpdate.impact.separator': '、',
    'desktopUpdate.impact.stops': '这会停止 {{work}}。',
    'desktopUpdate.impact.terminalsOne': '1 个 Terminal',
    'desktopUpdate.impact.terminalsOther': '{{count}} 个 Terminal',
    'desktopUpdate.impact.working': '仍在工作的 Agent：{{titles}}。',
    'desktopUpdate.label': 'Caxri',
    'desktopUpdate.manualInstall': '这个更新需要在电脑上打开下载好的磁盘映像来安装。',
    'desktopUpdate.rateLimited': '请稍后再试',
    'desktopUpdate.readyDetail': '已下载并校验。点按以重启电脑上的 Caxri。',
    'desktopUpdate.resetsData':
        '这个更新会清空你的 Project 和 Session 列表。请在电脑上安装，那里可以先导出它们。',
    'desktopUpdate.restartTo': '重启以更新到 {{version}}',
    'desktopUpdate.restarting': '正在把电脑更新到 {{version}}…',
    'desktopUpdate.restartingDetail': 'Caxri 重新启动后，此 App 会自动重连。',
    'desktopUpdate.retry': '重试更新到 {{version}}',
    'desktopUpdate.updateHint': '更新你电脑上的 Caxri。',
    'desktopUpdate.updateTo': '将电脑更新到 {{version}}',
};

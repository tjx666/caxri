import type { TranslatedNamespace } from '@caxri/protocol';

import type { update as source } from '../en/update';

export const update: TranslatedNamespace<typeof source> = {
    'update.action': '更新',
    'update.available': '有可用更新',
    'update.availableDetail': '来自你电脑的版本 {{version}} · {{size}}',
    'update.downloadIncomplete': '下载不完整，请重试。',
    'update.downloading': '正在下载 {{percent}}%',
    'update.failed': '更新失败。请确认这台手机能连接到你的电脑，然后重试。',
    'update.later': '稍后',
    'update.mismatchBody': '此 App 与你电脑上的 Caxri 版本不一致。请将两者都更新到最新版本。',
    'update.openingInstaller': '正在打开安装程序…',
    'update.required': '需要更新',
    'update.requiredDetail': '这台电脑运行的是较新的 Caxri。请更新此 App 以重新连接。',
    'update.retryUpdate': '重试更新',
    'update.settingsRowHint': '从你的电脑下载新版本，并打开 Android 安装程序。',
    'update.unreachable': '无法连接到你的电脑获取更新。',
    'update.updateTo': '更新到 {{version}}',
};

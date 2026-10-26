import type { TranslatedNamespace } from '@caxri/protocol';

import type { settingsNotifications as source } from '../en/settings-notifications';

export const settingsNotifications: TranslatedNamespace<typeof source> = {
    'settings.notificationHelper.status.helper': '由通知助手投递',
    'settings.notificationHelper.status.native': '由 macOS 通知投递',
    'settings.notificationHelper.status.missing': '尚未安装通知助手。请运行以下命令安装：',
    'settings.notificationHelper.status.basic':
        '正在使用基础 macOS 通知。请运行以下命令安装通知助手：',
    'settings.notificationHelper.note.basic': '点击通知横幅无法打开对应会话。',
    'settings.notificationHelper.note.unavailable': '安装通知助手之前，无法显示通知横幅。',
    'settings.notificationHelper.copyCommand': '复制',
    'settings.notificationHelper.checkAgain': '重新检查',
    'settings.notificationHelper.checking': '正在检查…',
    'settings.notificationHelper.sendTest': '发送测试通知',
    'settings.notificationHelper.openMacosSettings': '打开 macOS 通知设置',
    'settings.notificationHelper.test.title': 'Caxri',
    'settings.notificationHelper.test.body': '这是一条测试通知。',
    'settings.notificationHelper.test.sent':
        '测试通知已发送。如果没有看到，请检查 macOS 通知设置和专注模式。',
    'settings.notificationHelper.test.notSent': '无法发送测试通知。',
    'settings.notificationHelper.test.failed': '无法发送测试通知',
    'settings.notificationHelper.recheck.failed': '无法检查通知状态',
    'settings.notificationHelper.openMacosSettings.failed': '无法打开 macOS 设置',
    'settings.notificationHelper.toast.unavailable': '未安装通知助手，系统通知目前无法显示。',
};

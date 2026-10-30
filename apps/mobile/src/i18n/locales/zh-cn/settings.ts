import type { TranslatedNamespace } from '@caxri/protocol';

import type { settings as source } from '../en/settings';

export const settings: TranslatedNamespace<typeof source> = {
    'settings.access': '访问权限',
    'settings.back': '返回',
    'settings.forgetComputer': '忘记这台电脑',
    'settings.forgetComputerHint': '移除此配对前会先请你确认。',
    'settings.name': '名称',
    'settings.releaseNotes': '更新日志',
    'settings.releaseNotesHint': '在 GitHub 打开此版本的发布说明。',
    'settings.reportIssue': '反馈问题',
    'settings.reportIssueHint': '在 GitHub 新建 issue。',
    'settings.role.control': '控制',
    'settings.role.controlDescription':
        '包含回复权限，并可新建、重命名和归档会话、接管终端以及添加项目。',
    'settings.role.reply': '回复',
    'settings.role.replyDescription': '包含查看权限，并可回复 Agent、将会话标记为已读。',
    'settings.role.view': '查看',
    'settings.role.viewDescription': '查看会话、终端预览、更改和文件。',
    'settings.section.about': '关于',
    'settings.section.computer': '电脑',
    'settings.section.thisDevice': '本设备',
    'settings.sourceCode': '源代码',
    'settings.sourceCodeHint': '在 GitHub 打开 Caxri 仓库。',
    'settings.status': '状态',
    'settings.status.connected': '已连接',
    'settings.status.connecting': '正在连接…',
    'settings.status.notPaired': '未配对',
    'settings.status.reconnecting': '正在重新连接…',
    'settings.status.revoked': '已撤销',
    'settings.status.storageError': '已保存的配对信息不可用',
    'settings.status.unverified': '配对未验证',
    'settings.status.updateRequired': '需要更新',
    'settings.title': '设置',
    'settings.unknown': '未知',
    'settings.version': '版本',
};

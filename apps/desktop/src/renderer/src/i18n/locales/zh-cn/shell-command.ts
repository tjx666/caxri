import type { TranslatedNamespace } from '@caxri/protocol';

import type { shellCommand as source } from '../en/shell-command';

export const shellCommand: TranslatedNamespace<typeof source> = {
    'shellCommand.installed': '已在 PATH 中安装 Shell 命令“caxri”，位置：{{path}}。',
    'shellCommand.alreadyInstalled': 'Shell 命令“caxri”已安装在 {{path}}。',
    'shellCommand.uninstalled': '已从 {{path}} 移除 Shell 命令“caxri”。',
    'shellCommand.notInstalled': 'Shell 命令“caxri”未安装在 {{path}}。',
    'shellCommand.installFailed': '无法安装 Shell 命令“caxri”',
    'shellCommand.uninstallFailed': '无法卸载 Shell 命令“caxri”',
};

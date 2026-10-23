import type { TranslatedNamespace } from '@caxri/protocol';

import type { sshHost as source } from '../en/ssh-host';

export const sshHost: TranslatedNamespace<typeof source> = {
    // 窗口标识：窗口标题与状态栏指示
    'sshHost.windowTitle': 'SSH: {{destination}}',
    'sshHost.status.ariaLabel': '此窗口运行在 SSH Host {{destination}} 上',
    'sshHost.status.tooltip': '此窗口中的项目、终端和 Agent 都运行在 SSH Host {{destination}} 上。',
    'sshHost.status.platformLinux':
        '{{hostname}} · Linux {{architecture}} · glibc {{systemVersion}}',
    'sshHost.status.platformMacos': '{{hostname}} · macOS {{systemVersion}} · {{architecture}}',
    'sshHost.status.stopServer': '停止 SSH Host 上的 Server…',

    // 连接到 SSH Host 对话框
    'sshHost.connect.title': '连接到 SSH Host',
    'sshHost.connect.inputLabel': 'SSH 目标',
    'sshHost.connect.placeholder': 'user@host[:port]，或 ~/.ssh/config 中的 Host',
    'sshHost.connect.typed': '连接到 {{destination}}',
    'sshHost.connect.recent': '最近使用',
    'sshHost.connect.config': 'SSH 配置',
    'sshHost.connect.invalid': 'SSH 目标不能以“-”开头，也不能包含空格。',
    'sshHost.connect.empty': '输入 user@host，或选择“打开 SSH 配置”添加 Host。',
    'sshHost.connect.openConfig': '打开 SSH 配置',
    'sshHost.connect.openConfigFailed': '无法显示 SSH 配置文件',
    'sshHost.connect.noMatch': '没有匹配的 SSH Host。输入完整的 user@host 即可连接。',
    'sshHost.connect.loadFailed': '无法读取 ~/.ssh/config。仍可直接输入目标。',
    'sshHost.connect.failed': '无法打开 SSH Host 窗口',
    'sshHost.connect.reused': '此窗口已连接到 {{destination}}（与 {{typed}} 是同一 SSH Host）',

    // 连接遮罩
    'sshHost.phase.connecting': '正在连接…',
    'sshHost.phase.probing': '正在检查 SSH Host…',
    'sshHost.phase.installing': '正在安装 Caxri Server…',
    'sshHost.phase.starting': '正在启动 Caxri Server…',
    'sshHost.phase.connected': '已连接',
    'sshHost.phase.reconnecting': '正在重新连接…',
    'sshHost.phase.reconnectingAttempt': '正在重新连接（第 {{attempt}} 次尝试）…',
    'sshHost.phase.disconnected': '已断开连接',
    'sshHost.phase.stopped': '正在停止 Server…',
    'sshHost.phase.failed': '无法连接',
    'sshHost.phase.cancelled': '连接已取消',
    'sshHost.progress.label': '正在安装 Caxri Server',
    'sshHost.progress.percent': '{{percent}}%',
    'sshHost.failure.authentication':
        'SSH Host 未接受你的凭据。请检查密码、密钥或两步验证码，然后重新连接。',
    'sshHost.failure.hostKey':
        '无法验证 SSH Host 的主机密钥。如果该主机重装过系统，请先更新 ~/.ssh/known_hosts 再重新连接。',
    'sshHost.failure.unreachable':
        '无法访问 SSH Host。请检查网络、VPN，以及 ~/.ssh/config 中的主机名。',
    'sshHost.failure.unsupportedPlatform':
        'Caxri Server 可以运行在 Linux x64 和 arm64，以及 Apple 芯片上的 macOS 13.5 或更高版本，这台 SSH Host 的系统不受支持。',
    'sshHost.failure.unsupportedGlibc':
        'Caxri Server 需要 glibc 2.28 或更高版本（例如 Ubuntu 20.04、Debian 10 或 RHEL 8），这台 SSH Host 的版本过旧。',
    'sshHost.failure.missingTool':
        'SSH Host 缺少 Caxri 安装 Server 所需的命令，例如 tar 或 sha256sum。',
    'sshHost.failure.installFailed':
        '无法在 SSH Host 上安装 Caxri Server。请检查磁盘剩余空间以及 ~/.caxri-server 的权限。',
    'sshHost.failure.launchFailed': 'Caxri Server 已安装，但未能在 SSH Host 上启动。',
    'sshHost.failure.profileInUse':
        '另一台与此主机共用 home 目录的机器正在运行使用同一份数据的 Caxri Server。请先停止那个 Server，或在它退出约一分钟后再重新连接。',
    'sshHost.failure.profileInUseHost':
        '另一台与此主机共用 home 目录的机器（{{hostname}}）正在运行使用同一份数据的 Caxri Server。请先停止那个 Server，或在它退出约一分钟后再重新连接。',
    'sshHost.failure.takenOver':
        '另一个窗口或另一台电脑上的 Caxri 接管了这个 SSH Host 的 Server。终端和 Agent 仍在那里运行。',
    'sshHost.failure.cancelled': '需要时选择“重新连接”即可再次连接。',
    'sshHost.failure.connectionLost':
        '与 SSH Host 的连接已断开。其中的终端和 Agent 会继续运行，重新连接后即可恢复显示。',
    'sshHost.failure.unknown': '连接 SSH Host 时出现问题。',
    'sshHost.reconnect': '重新连接',
    'sshHost.useHere': '在此处使用',
    'sshHost.workbenchPaused': '正在显示断开前的窗口内容，SSH Host 恢复后即可继续操作。',
    'sshHost.closeWindow': '关闭窗口',
    'sshHost.copyDetails': '复制详细信息',
    'sshHost.copyCommand': '复制命令',
    'sshHost.retryNow': '立即重试',
    'sshHost.retryNow.failed': '无法立即重试',
    'sshHost.reconnect.failed': '无法重新连接到 SSH Host',
    'sshHost.cancel.failed': '无法取消连接',

    // OpenSSH 提示（密码、密钥口令、两步验证码、主机密钥）
    'sshHost.askpass.title': '{{destination}} 需要你的回应',
    'sshHost.askpass.passwordTitle': '输入 {{destination}} 的密码',
    'sshHost.askpass.passphraseTitle': '输入 {{destination}} 的密钥口令',
    'sshHost.askpass.verifyTitle': '验证 {{destination}}',
    'sshHost.askpass.trust': '信任并连接',
    'sshHost.askpass.continue': '继续',
    'sshHost.askpass.inputLabel': '回应',
    'sshHost.askpass.privacy': 'Caxri 只把此回应交给 OpenSSH，不会保存。',
    'sshHost.askpass.retry': 'OpenSSH 拒绝了上一次的回应。第 {{count}} 次尝试。',
    'sshHost.askpass.failed': '无法回应 SSH Host',

    // 停止 SSH Host 上的 Server
    'sshHost.stop.title': '要停止 {{destination}} 上的 Server 吗？',
    'sshHost.stop.message':
        '这台 SSH Host 上运行的所有终端和 Agent 都会结束，此窗口也会关闭。再次连接时会启动新的 Server。',
    'sshHost.stop.confirm': '停止 Server',
    'sshHost.stop.failed': '无法停止 SSH Host 上的 Server',

    // SSH Host 上的项目文件夹选择器
    'sshHost.folderPicker.title': '在 {{destination}} 上选择项目文件夹',
    'sshHost.folderPicker.pathLabel': '文件夹路径',
    'sshHost.folderPicker.pathPlaceholder': '输入 /绝对路径 或 ~/文件夹，然后按 Enter',
    'sshHost.folderPicker.parent': '上级文件夹',
    'sshHost.folderPicker.home': '主文件夹',
    'sshHost.folderPicker.breadcrumbs': '当前文件夹',
    'sshHost.folderPicker.listLabel': '文件夹',
    'sshHost.folderPicker.loading': '正在加载文件夹',
    'sshHost.folderPicker.gitRepository': 'Git',
    'sshHost.folderPicker.gitRepositoryDescription': 'Git 仓库',
    'sshHost.folderPicker.noMatch': '没有与输入匹配的文件夹。',
    'sshHost.folderPicker.empty': '此文件夹中没有子文件夹。',
    'sshHost.folderPicker.truncated': '仅列出了前 {{count}} 个文件夹。输入路径可继续深入。',
    'sshHost.folderPicker.loadFailed': '无法列出此文件夹。{{message}}',
    'sshHost.folderPicker.invalidPath':
        '请输入绝对路径（如 /srv/app），或主文件夹中的路径（如 ~/app）。',
    'sshHost.folderPicker.open': '打开',
    'sshHost.watchLimit.watches':
        'SSH Host 的文件监听数已用尽（fs.inotify.max_user_watches），文件树和 Git 状态可能要过几秒才会更新。如需调高上限，请复制命令并在 SSH Host 上以 sudo 权限运行，Caxri 会自动恢复实时更新。',
    'sshHost.watchLimit.instances':
        'SSH Host 的文件监听器数量已用尽（fs.inotify.max_user_instances），文件树和 Git 状态可能要过几秒才会更新。如需调高上限，请复制命令并在 SSH Host 上以 sudo 权限运行，Caxri 会自动恢复实时更新。',

    // SSH Host 窗口中的“按路径打开文件”
    'sshHost.pathBrowser.homeUnavailable':
        '在 SSH Host 上，“按路径打开文件”只能打开此项目中的文件。请输入项目内的路径。',
    'sshHost.pathBrowser.outsideProject':
        '该路径不在此项目中。在 SSH Host 上，“按路径打开文件”只能打开此项目中的文件。',
};

import type { TranslatedNamespace } from '@caxri/protocol';

import type { sshHost as source } from '../en/ssh-host';

export const sshHost: TranslatedNamespace<typeof source> = {
    // 窗口标识：窗口标题与状态栏指示
    'sshHost.windowTitle': 'SSH: {{destination}}',
    'sshHost.status.ariaLabel': '此会话运行在 SSH Host {{destination}} 上',
    'sshHost.status.tooltip': '此会话的项目、终端和 Agent 都运行在 SSH Host {{destination}} 上。',
    'sshHost.hostMark': '位于 {{destination}}',
    'sshHost.hostMark.named': '位于 {{name}}（{{destination}}）',
    'sshHost.icon.system': '系统',
    'sshHost.icon.place': '地点',
    'sshHost.icon.device': '设备',
    'sshHost.icon.home': '家里',
    'sshHost.icon.office': '办公室',
    'sshHost.icon.remote': '远程',
    'sshHost.icon.cloud': '云端',
    'sshHost.icon.laptop': '笔记本',
    'sshHost.icon.desktop': '台式机',
    'sshHost.icon.server': '服务器',
    'sshHost.icon.gpu': 'GPU',
    'sshHost.icon.auto': '自动',
    'sshHost.icon.detected': '检测到：{{system}}',
    'sshHost.icon.detectedLater': '首次连接时检测',
    'sshHost.icon.notDetected': '尚未检测',
    'sshHost.icon.color': '颜色',
    'sshHost.icon.defaultColor': '默认颜色',
    'sshHost.icon.colorAriaLabel': '{{color}}色',
    'sshHost.preferences.failed': '无法保存主机设置',
    'sshHost.addProject.title': '在哪台机器上添加项目…',
    'sshHost.addProject.description': '本机会打开文件夹对话框；SSH 主机会打开它的文件夹浏览器。',
    'sshHost.settings.connect': '连接到 SSH 主机…',
    'sshHost.settings.column.host': '主机',
    'sshHost.settings.column.icon': '图标',
    'sshHost.settings.column.name': '显示名称',
    'sshHost.settings.column.reconnectOnLaunch': '启动时重连',
    'sshHost.settings.localMachine': '本地机器',
    'sshHost.settings.connected': '已连接',
    'sshHost.settings.disconnected': '已断开',
    'sshHost.settings.reconnecting': '正在重连',
    'sshHost.settings.failed': '无法连接',
    'sshHost.settings.iconFor': '{{name}} 的图标',
    'sshHost.settings.nameFor': '{{name}} 的显示名称',
    'sshHost.settings.reconnectOnLaunchFor': '启动时重连 {{name}}',
    'sshHost.settings.moreFor': '{{name}} 的更多操作',
    'sshHost.settings.connectHost': '连接',
    'sshHost.settings.reconnectHost': '重新连接 SSH 主机',
    'sshHost.thisMac': '本机',
    'sshHost.disconnect': '断开连接',
    'sshHost.disconnect.failed': '无法断开 SSH Host',
    'sshHost.status.disconnect': '断开与 {{destination}} 的连接',
    'sshHost.status.platformLinux':
        '{{hostname}} · Linux {{architecture}} · glibc {{systemVersion}}',
    'sshHost.status.platformMacos': '{{hostname}} · macOS {{systemVersion}} · {{architecture}}',
    'sshHost.status.reconnectOnLaunch': '启动时重连',
    'sshHost.status.manageHosts': '管理主机…',
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
    'sshHost.connect.failed': '无法连接到 SSH Host',
    'sshHost.connect.reused': '已连接到 {{destination}}（与 {{typed}} 是同一 SSH Host）',

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
    'sshHost.phase.updateDeferred': '已暂缓更新 Server',
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
    'sshHost.failure.updateDeferred':
        'SSH Host 上的 Caxri Server 来自另一个版本，其中的终端和 Agent 仍在运行。准备好更新时选择“重新连接”。',
    'sshHost.failure.connectionLost':
        '与 SSH Host 的连接已断开。其中的终端和 Agent 会继续运行，重新连接后即可恢复显示。',
    'sshHost.failure.unknown': '连接 SSH Host 时出现问题。',
    'sshHost.reconnect': '重新连接',
    'sshHost.useHere': '在此处使用',
    'sshHost.workbenchPaused':
        '此会话的终端和 Agent 仍在 SSH Host 上运行，恢复连接后即可继续操作。',
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
        '这台 SSH Host 上运行的所有终端和 Agent 都会结束，它的项目也会从侧边栏移除。再次连接时会启动新的 Server。',
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

import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { settingsPage as source } from '../en/settings-page';

export const settingsPage: TranslatedNamespace<typeof source> = {
    'settings.page.heading': '设置',
    'settings.page.intro': '更改会立即生效，并保存为可编辑的文件。',
    'settings.page.sections': '设置分区',
    'settings.page.tab.settings': '设置',
    'settings.page.tab.keybindings': '快捷键',
    'settings.page.tab.theme': '主题',
    'settings.page.viewToggle': '设置视图',
    'settings.page.view.ui': '界面',
    'settings.page.view.source': '源文件',
    'settings.page.categoriesNav': '设置分类',
    'settings.page.search': '搜索设置',
    'settings.page.clearSearch': '清除搜索',
    'settings.page.clearSearchLabel': '清除设置搜索',
    'settings.page.searchCount': '{{visible}} / {{total}} 项设置',
    'settings.page.noMatches': '没有与“{{query}}”匹配的设置',
    'settings.page.accessibleTitle': '{{category}} {{title}}',
    'settings.page.resetToDefault': '恢复默认值',
    'settings.page.resetRowToDefault': '将“{{title}}”恢复为默认值',
    'settings.page.moreAbout': '关于“{{title}}”的更多信息',
    'settings.page.loadFailed': '无法加载配置',
    'settings.page.skillHealthFailed': '无法检查 Caxri CLI Skill',

    'settings.source.editorLabel': '{{fileName}} 源文件',
    'settings.source.goToLine': '转到第 {{line}} 行',
    'settings.source.revert': '还原更改',
    'settings.source.parseLocation': '第 {{line}} 行第 {{column}} 列：{{description}}',
    'settings.source.invalidConfiguration': '配置无效',
    'settings.source.parseError.invalidSymbol': '发现无效符号',
    'settings.source.parseError.invalidNumberFormat': '此数字无效',
    'settings.source.parseError.propertyNameExpected': '缺少属性名',
    'settings.source.parseError.valueExpected': '缺少值',
    'settings.source.parseError.colonExpected': '缺少冒号 :',
    'settings.source.parseError.commaExpected': '缺少逗号 ,',
    'settings.source.parseError.closeBraceExpected': '缺少右花括号 }',
    'settings.source.parseError.closeBracketExpected': '缺少右方括号 ]',
    'settings.source.parseError.endOfFileExpected': 'JSON 值之后还有多余内容',
    'settings.source.parseError.invalidCommentToken': '此注释无效',
    'settings.source.parseError.unexpectedEndOfComment': '此注释未闭合',
    'settings.source.parseError.unexpectedEndOfString': '此字符串未闭合',
    'settings.source.parseError.unexpectedEndOfNumber': '此数字不完整',
    'settings.source.parseError.invalidUnicode': '此 Unicode 转义无效',
    'settings.source.parseError.invalidEscapeCharacter': '此转义字符无效',
    'settings.source.parseError.invalidCharacter': '发现无效字符',
    'settings.source.parseError.unknown': 'JSON 语法无效',

    'settings.integerControl.range': '请输入 {{lower}} 到 {{upper}} 之间的数字。',
    'settings.integerControl.rangeWithUnit':
        '请输入 {{lower}} 到 {{upper}} 之间的数字（单位：{{unit}}）。',
    'settings.integerControl.wholeNumber': '请输入 {{lower}} 到 {{upper}} 之间的整数。',
    'settings.integerControl.wholeNumberWithUnit':
        '请输入 {{lower}} 到 {{upper}} 之间的整数（单位：{{unit}}）。',

    'settings.argvRestart.prefix': '重启 Caxri 以应用新的',
    'settings.argvRestart.namedOne': '{{titles}}设置。',
    'settings.argvRestart.namedOther': '{{titles}}设置。',
    'settings.argvRestart.unnamedOne': '设置。',
    'settings.argvRestart.unnamedOther': '设置。',
    'settings.argvRestart.listSeparator': '、',
    'settings.argvRestart.listFinalSeparator': '和',

    'settings.row.skippedVersion.current': '当前跳过 {{version}}。',
    'settings.row.skippedVersion.none': '当前未跳过任何版本。',
    'settings.row.archivedSessions.title': '已归档的会话',
    'settings.row.archivedSessions.description': '恢复或永久删除已归档的会话',
    'settings.row.archivedSessions.manage': '管理…',
    'settings.row.mobileAccess.title': '移动设备访问',
    'settings.row.mobileAccess.description':
        '配对此局域网中的手机和平板，以查看授权范围内的 Agent 会话并发送简短回复',
    'settings.row.hardwareAcceleration.title': '硬件加速',
    'settings.row.hardwareAcceleration.description':
        '控制整个应用是否使用图形硬件绘制，包括下方每个终端的 GPU 加速。关闭后，Caxri 使用软件渲染，速度较慢，但在图形出错时仍能正常工作。Caxri 只会在你确认后更改此项，更改在重启后生效。',
    'settings.row.hardwareAcceleration.offStatus': '在重新开启此项之前，Caxri 会以软件渲染启动。',
    'settings.row.remoteDebugging.title': '调试端口',
    'settings.row.remoteDebugging.description':
        '开启时，Caxri 监听 127.0.0.1:9224，这台 Mac 上运行的任何程序都可以通过 Chrome DevTools Protocol 连接。连接者可以读取每个窗口、在其中运行代码并以你的身份操作。其他机器无法访问该地址。关闭时不监听任何端口。对已安装的应用在下次启动时生效；从源码启动的 Caxri 始终在 127.0.0.1:9223 上监听。',
    'settings.row.delegationDepth.title': '委派深度',
    'settings.row.delegationDepth.description': 'Agent 可以连续将部分工作交给另一个 Agent 的次数。',
    'settings.row.delegationDepth.detail':
        '设为 1 时，你启动的 Agent 可以引入一个助手，由它独自完成；设为 2 时，该助手还可以再引入一个。可以引入哪些 Agent 由委派预设决定，在源文件视图中编辑。',

    'settings.row.providerActions.title': 'Agent 命令和 Skill',
    'settings.row.providerActions.description':
        '自定义“Agent 命令和 Skill”选择器中显示的斜杠命令和 Skill 调用。项目和用户 Skill 会自动发现。',
    'settings.row.providerActions.unavailable': '{{provider}} 不支持命令和 Skill。',
    'settings.row.providerHooks.title': '生命周期 Hook',
    'settings.row.providerHooks.description':
        '让后台会话的未读状态保持准确。Caxri 只接收生命周期阶段，从不接收提示词或回复内容。请重启在启用生命周期 Hook 之前打开的 Agent 终端。',
    'settings.row.providerHooks.label': '{{provider}} 生命周期 Hook',
    'settings.row.providerMessaging.title': '对等消息',
    'settings.row.providerMessaging.description':
        '允许此 Agent 通过对等收件箱与其他 Agent 收发简短消息。消息从不会输入到终端中。关闭后立即生效；仅当消息功能仍不可用时才需要重启终端。',
    'settings.row.providerMessaging.label': '{{provider}} 对等消息',
    'settings.row.providerMessaging.unavailable': '{{provider}} 不支持此功能。',
    'settings.row.providerRecovery.title': '网络错误恢复',
    'settings.row.providerRecovery.description':
        '当 Agent 因 Caxri 可识别的网络错误或你添加的额外模式而停止时，Caxri 会等待、按下 Esc、再次等待，然后发送“continue”。默认关闭。',
    'settings.row.providerRecovery.label': '{{provider}} 网络错误恢复',
    'settings.row.providerSkill.title': 'Caxri CLI Skill',
    'settings.row.providerSkill.description': '此提供方内置 Caxri Skill 的安装状态',
    'settings.row.providerExecutable.title': '可执行文件',
    'settings.row.providerExecutable.description': '在新终端中启动此 Agent 所用的命令',
    'settings.row.providerExecutable.label': '{{provider}} 可执行文件',
    'settings.row.providerAutonomy.title': '允许 Agent 无需每次询问即可操作',
    'settings.row.providerAutonomy.description':
        '开启时，此 Agent 在其终端中编辑文件和运行命令，无需每次停下来等待你的批准。关闭时，每次操作前都会询问。对此后启动的终端生效，不影响已在运行的终端。',
    'settings.row.providerAutonomy.label': '允许 {{provider}} 无需每次询问即可操作',
    'settings.row.providerArgs.title': '初始参数',
    'settings.row.providerArgs.description':
        '每次启动时传入。按命令行的方式书写参数；参数及其值可以写在同一行。',
    'settings.row.providerArgs.label': '{{provider}} 初始参数',
};

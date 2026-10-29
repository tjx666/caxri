import type { TranslatedNamespace } from '@caxri/protocol';

import type { settingsCatalog as source } from '../en/settings-catalog';

export const settingsCatalog: TranslatedNamespace<typeof source> = {
    'settings.category.general': '通用',
    'settings.category.chat': '对话',
    'settings.category.notifications': '通知',
    'settings.category.mobile': '移动设备',
    'settings.category.terminal': '终端',
    'settings.category.editor': '编辑器',
    'settings.category.security': '安全',
    'settings.category.files': '文件',
    'settings.category.projectStatus': '项目状态',
    'settings.category.agents': 'Agent',

    'settings.unit.px': 'px',
    'settings.unit.lines': '行',
    'settings.unit.characters': '个字符',
    'settings.unit.minutes': '分钟',
    'settings.unit.MB': 'MB',
    'settings.unit.seconds': '秒',

    'settings.workbench.language.title': '语言',
    'settings.workbench.language.description':
        '界面的显示语言。跟随系统时，系统语言为中文则使用简体中文。',
    'settings.workbench.language.nullLabel': '跟随系统',
    'settings.workbench.language.nullLabelResolved': '跟随系统（{{language}}）',

    'settings.notifications.worktreeFallback.title': 'Worktree 回退提醒',
    'settings.notifications.worktreeFallback.description':
        '不可用的 Worktree 回退到其项目时显示弹窗。开启可恢复已静音的提醒。对所有项目生效；最近的事件仍保留在通知中。',
    'settings.notifications.agentRecovery.title': 'Agent 自动恢复提醒',
    'settings.notifications.agentRecovery.description':
        'Agent 自动恢复后显示弹窗。开启可恢复已静音的提醒。对所有项目生效；失败始终会显示。',

    'settings.session.defaultAgent.title': '默认 Agent',
    'settings.session.defaultAgent.description':
        '新会话和新终端使用此 Agent 启动。选择“每次询问”则改为打开列表；“新建终端”按钮始终提供其他 Agent。',
    'settings.session.defaultAgent.nullLabel': '每次询问',

    'settings.session.openAgentsInChat.title': '在对话中打开 Agent',
    'settings.session.openAgentsInChat.description':
        '新 Agent 以对话而非终端的形式启动。Shell 始终在终端中打开。“新建会话”和“新建终端”菜单也可切换此项。',

    'settings.agentChat.longPasteThreshold.title': '对话长文本粘贴阈值',
    'settings.agentChat.longPasteThreshold.description':
        '粘贴到对话中的较长文本会保存为本地文件并在消息中引用，避免日志或转储淹没消息。调高此值即可原样粘贴这类文本；一条消息放不下的文本仍会保存为文件。',

    'settings.agentChat.workingIndicator.title': '对话工作指示',
    'settings.agentChat.workingIndicator.description':
        'Agent 生成回复时对话中显示的动画。选择“小家伙”时，状态栏的加载图标也会换成它，并演出 Agent 正在做的事：阅读、搜索、运行命令。开启“减弱动态效果”后所有选项都会静止。',
    'settings.agentChat.workingIndicator.option.buddy': '小家伙',
    'settings.agentChat.workingIndicator.option.dots': '圆点',
    'settings.agentChat.workingIndicator.option.caret': '光标',
    'settings.agentChat.workingIndicator.option.braille': '盲文点阵',
    'settings.agentChat.workingIndicator.option.orbit': '轨道',

    'settings.agentChat.animatedToolIcons.title': '对话工具图标动画',
    'settings.agentChat.animatedToolIcons.description':
        '对话中正在运行的工具行会用图标动画演出当前工作，例如阅读时有只书虫在书上爬。关闭后保持静态图标。',

    'settings.agentChat.statusShimmer.title': '对话状态扫光',
    'settings.agentChat.statusShimmer.description':
        '对话中运行状态文字的扫光方式，例如工作短语和正在运行的工具标题。',
    'settings.agentChat.statusShimmer.option.dwell': '扫一下歇一会儿',
    'settings.agentChat.statusShimmer.option.continuous': '持续扫光',
    'settings.agentChat.statusShimmer.option.off': '关闭',

    'settings.workbench.newWorktreeBehavior.title': '新 Worktree 行为',
    'settings.workbench.newWorktreeBehavior.description':
        '选择是否跟随检测到的 Worktree。“自动继续”会直接授权新的 Worktree 文件夹，不再询问。',
    'settings.workbench.newWorktreeBehavior.option.ask': '询问',
    'settings.workbench.newWorktreeBehavior.option.continueWhenAuthorized': '已授权时继续',
    'settings.workbench.newWorktreeBehavior.option.continueAutomatically': '自动继续',
    'settings.workbench.newWorktreeBehavior.option.ignore': '忽略',

    'settings.workbench.confirmWorktreeAuthorization.title': '授权 Worktree 前确认',
    'settings.workbench.confirmWorktreeAuthorization.description':
        '从状态栏选择未授权的 Worktree 时先询问。关闭后直接授权并切换。',

    'settings.primarySidebar.autoCollapseProjects.title': '自动折叠不活跃的项目',
    'settings.primarySidebar.autoCollapseProjects.description':
        '活跃、运行中、有未读以及手动展开的项目保持展开',
    'settings.primarySidebar.autoCollapseProjects.option.off': '关闭',
    'settings.primarySidebar.autoCollapseProjects.option.30m': '30 分钟后',
    'settings.primarySidebar.autoCollapseProjects.option.2h': '2 小时后',

    'settings.primarySidebar.showSubagents.title': '在会话下显示子 Agent',
    'settings.primarySidebar.showSubagents.description':
        '在主侧边栏中，把对话中的 Agent 启动的子 Agent 作为缩进行列在其会话下方',

    'settings.primarySidebar.translucent.title': '半透明侧边栏',
    'settings.primarySidebar.translucent.description':
        '在 macOS 上，主题与系统的浅色或深色外观一致时，侧边栏透出模糊的桌面，呈磨砂玻璃效果。',
    'settings.primarySidebar.translucent.inactive.fullScreen':
        '未生效：窗口处于全屏，没有可模糊的桌面。',
    'settings.primarySidebar.translucent.inactive.themeDarkSystemLight':
        '未生效：当前主题为深色，而 macOS 使用浅色外观。',
    'settings.primarySidebar.translucent.inactive.themeLightSystemDark':
        '未生效：当前主题为浅色，而 macOS 使用深色外观。',

    'settings.statusBar.usage.showFiveHourLimit.title': '在状态栏显示 5 小时限额',
    'settings.statusBar.usage.showFiveHourLimit.description':
        '在 Agent 用量标签中，于每周限额旁同时显示 5 小时套餐限额。悬停卡片始终列出全部限额。',

    'settings.window.zoomLevel.title': '缩放级别',
    'settings.window.zoomLevel.description':
        '缩放整个界面。0 为原始大小；每增减一级缩放 20%。“视图 › 放大”“缩小”和“重置缩放”也会更改此项。',

    'settings.workbench.fontFamily.title': '字体',
    'settings.workbench.fontFamily.description': '工作台界面字体；留空则使用系统字体',
    'settings.workbench.fontFamily.placeholder': '系统字体',

    'settings.workbench.externalEditor.title': '外部编辑器',
    'settings.workbench.externalEditor.description':
        '“在外部编辑器中打开项目”使用的命令（例如 code、cursor、subl）',

    'settings.mobile.relayUrl.title': '中继服务器',
    'settings.mobile.relayUrl.description':
        'Caxri 中继的 ws:// 或 wss:// 地址。局域网地址都连不上时，已配对的手机会改走中继；流量始终端到端加密。留空则只使用局域网。',

    'settings.updates.skippedVersion.title': '已跳过的更新版本',
    'settings.updates.skippedVersion.description':
        '在出现更新的版本之前，Caxri 不再推荐此版本。重置后会再次推荐。',

    'settings.terminal.fontFamily.title': '字体',
    'settings.terminal.fontFamily.description': '优先于内置的 JetBrains Mono 后备字体使用',

    'settings.terminal.fontSize.title': '字号',

    'settings.terminal.scrollback.title': '回滚行数',
    'settings.terminal.scrollback.description': '终端缓冲区在可见区域之外保留的行数',

    'settings.terminal.longPasteThreshold.title': '长文本粘贴阈值',
    'settings.terminal.longPasteThreshold.description':
        '粘贴到运行中 Agent 的较长文本会保存为本地文件并替换为其路径，让 Agent 读取文件，而不是通过终端接收。最大值让普通粘贴保持原生方式；更大的文本仍会保存为文件。',

    'settings.terminal.copyOnSelect.title': '选中即复制',
    'settings.terminal.copyOnSelect.description': '自动将终端中选中的内容复制到剪贴板',

    'settings.terminal.gpuAcceleration.title': '终端硬件加速',
    'settings.terminal.gpuAcceleration.description':
        '使用显卡绘制终端；关闭后改用软件渲染。切换后无需重启终端即可生效。硬件加速关闭时此项无效，因为那时所有终端都已使用软件渲染。',
    'settings.terminal.gpuAcceleration.option.auto': '自动',
    'settings.terminal.gpuAcceleration.option.on': '开启',
    'settings.terminal.gpuAcceleration.option.off': '关闭',

    'settings.terminal.suspendUntouchedAgents.title': '挂起打开后从未使用的 Agent',
    'settings.terminal.suspendUntouchedAgents.description':
        '切换到其他会话后，挂起你从未输入过内容的 Agent 以节省内存。回来时会从中断处继续。',

    'settings.terminal.idleSuspension.enabled.title': '在后台挂起空闲的 Agent',
    'settings.terminal.idleSuspension.enabled.description':
        '挂起已完成工作、并在你未查看的会话中等待的 Agent，以节省内存。回来时会从中断处继续。',

    'settings.terminal.idleSuspension.afterMinutes.title': '空闲 Agent 挂起时间',
    'settings.terminal.idleSuspension.afterMinutes.description':
        'Agent 在你未查看的会话中等待多久后被挂起。仅在“在后台挂起空闲的 Agent”开启时生效。即将为空闲生成摘要的较长对话会等摘要完成后再挂起。',

    'settings.agentChat.idleCompaction.enabled.title': '自动总结空闲的对话，保持回复迅速',
    'settings.agentChat.idleCompaction.enabled.description':
        '较长的 Claude 或 Grok Build 对话空闲一段时间后，Caxri 会在后台为它生成摘要，这样你的下一条消息只需带上简短摘要而不是整段对话，回复更快也更省用量。',
    'settings.agentChat.autoContinueAtUsageLimit.title': '用量限额重置后自动继续',
    'settings.agentChat.autoContinueAtUsageLimit.description':
        'Claude 或 Codex 的对话因套餐用量用完而停下时，等限额重置（24 小时内）后自动继续任务。你可以在对话中取消等待，或立即继续。',

    'settings.terminal.osc52ClipboardWrite.title': '允许终端中的程序复制到剪贴板',
    'settings.terminal.osc52ClipboardWrite.description':
        'tmux 或远程 Shell 等程序可以通过 OSC 52 将文本复制到你的剪贴板，但永远无法读取它',

    'settings.terminal.wordSeparators.title': '单词分隔符',
    'settings.terminal.wordSeparators.description':
        '双击选择时以及 Caxri 查找可链接的文件名时，用于结束一个单词的字符。file.ts:12 这类链接无论如何都会被识别',

    'settings.terminal.referenceLinks.title': '引用链接',
    'settings.terminal.referenceLinks.description':
        '使用网址模板，将 TASK-123 这类 issue 标记转换为链接',

    'settings.terminal.defaultWorkingDirectory.title': '新终端工作目录',
    'settings.terminal.defaultWorkingDirectory.description': '留空则使用当前的工作台根目录',
    'settings.terminal.defaultWorkingDirectory.placeholder': '当前工作台根目录',

    'settings.editor.fontFamily.title': '字体',
    'settings.editor.fontFamily.description': '代码和差异编辑器的字体；留空则使用 Monaco 默认字体',
    'settings.editor.fontFamily.placeholder': 'Monaco 默认字体',

    'settings.files.autoSave.title': '自动保存',
    'settings.files.autoSave.description': '自动保存修改过的文件，无需手动保存',
    'settings.files.autoSave.option.off': '关闭',
    'settings.files.autoSave.option.onFocusChange':
        '离开文件、切换标签页或关闭时保存。关闭有改动的标签页不再询问。',

    'settings.editor.fontSize.title': '字号',
    'settings.editor.fontSize.description': '代码和差异编辑器的字号',

    'settings.editor.wordWrap.title': '自动换行',
    'settings.editor.wordWrap.description': '长行自动换行，而不是水平滚动',
    'settings.editor.wordWrap.option.off': '关闭',
    'settings.editor.wordWrap.option.on': '在视口边缘换行',
    'settings.editor.wordWrap.option.bounded': '在第 80 列或视口边缘换行',

    'settings.editor.wordSeparators.title': '单词分隔符',
    'settings.editor.wordSeparators.description':
        '双击选择和按单词移动光标时，用于结束一个单词的字符',

    'settings.editor.autoClosingDelete.title': '成对删除括号和引号',
    'settings.editor.autoClosingDelete.description':
        '删除空括号或空引号的一半时，同时删除另一半。仅对相邻的空配对生效。',
    'settings.editor.autoClosingDelete.option.always': '始终',
    'settings.editor.autoClosingDelete.option.auto': '仅限此编辑器插入的配对',
    'settings.editor.autoClosingDelete.option.never': '从不',

    'settings.editor.linkedEditing.title': '链接编辑',
    'settings.editor.linkedEditing.description':
        '重命名 HTML 或 JSX 标签时，同步重命名与之匹配的标签',

    'settings.editor.stickyScroll.enabled.title': '粘性滚动',
    'settings.editor.stickyScroll.enabled.description': '将首行所在的外层作用域固定在编辑器顶部',

    'settings.editor.stickyTabStops.title': '粘性制表位',
    'settings.editor.stickyTabStops.description': '在空格缩进中每次按一个缩进级别移动光标',

    'settings.editor.bracketPairColorization.enabled.title': '括号对着色',
    'settings.editor.bracketPairColorization.enabled.description': '按嵌套深度为匹配的括号着色',

    'settings.editor.guides.bracketPairs.title': '括号对参考线',
    'settings.editor.guides.bracketPairs.description': '连接括号对的垂直参考线',
    'settings.editor.guides.bracketPairs.option.off': '关闭',
    'settings.editor.guides.bracketPairs.option.active': '仅当前括号对',
    'settings.editor.guides.bracketPairs.option.all': '所有括号对',

    'settings.editor.renderWhitespace.title': '显示空白字符',
    'settings.editor.renderWhitespace.description': '显示空格和制表符',
    'settings.editor.renderWhitespace.option.none': '从不',
    'settings.editor.renderWhitespace.option.boundary': '单词间的单个空格除外',
    'settings.editor.renderWhitespace.option.selection': '在选区内',
    'settings.editor.renderWhitespace.option.trailing': '仅行尾',
    'settings.editor.renderWhitespace.option.all': '始终',

    'settings.editor.cursorBlinking.title': '光标闪烁',
    'settings.editor.cursorBlinking.description': '光标在显示和隐藏之间的动画方式',
    'settings.editor.cursorBlinking.option.blink': '闪烁',
    'settings.editor.cursorBlinking.option.smooth': '平滑',
    'settings.editor.cursorBlinking.option.phase': '渐变',
    'settings.editor.cursorBlinking.option.expand': '扩展',
    'settings.editor.cursorBlinking.option.solid': '常亮',

    'settings.editor.cursorSmoothCaretAnimation.title': '光标平滑动画',
    'settings.editor.cursorSmoothCaretAnimation.description': '光标在位置之间移动时显示动画',
    'settings.editor.cursorSmoothCaretAnimation.option.off': '关闭',
    'settings.editor.cursorSmoothCaretAnimation.option.explicit': '仅限显式移动',
    'settings.editor.cursorSmoothCaretAnimation.option.on': '始终',

    'settings.editor.smoothScrolling.title': '平滑滚动',
    'settings.editor.smoothScrolling.description': '编辑器视口滚动时显示动画',

    'settings.editor.dragAndDrop.title': '拖放选中的文本',
    'settings.editor.dragAndDrop.description': '在编辑器内拖动选区以移动它',

    'settings.editor.minimap.enabled.title': '缩略图',
    'settings.editor.minimap.enabled.description': '在右侧边缘显示代码概览条',

    'settings.editor.unfoldOnClickAfterEndOfLine.title': '点击行尾后展开',
    'settings.editor.unfoldOnClickAfterEndOfLine.description': '点击折叠行之后的空白处即可展开',

    'settings.editor.foldOnOpenLineThreshold.title': '打开时折叠的行数阈值',
    'settings.editor.foldOnOpenLineThreshold.description':
        '首次打开超过此行数的文件时折叠所有代码块；JSON 保留顶层键可见。“全部展开”（⌘K ⌘J）可重新展开。设为 0 则打开时从不折叠。',

    'settings.git.fetchGitHubAvatars.title': '从 GitHub 获取提交头像',
    'settings.git.fetchGitHubAvatars.description':
        '在 GitHub 上查找提交作者的头像；作者邮箱会发送到 github.com。仅用于带有 GitHub 远程仓库的仓库。',

    'settings.security.trustedDomains.title': '受信任的域名',
    'settings.security.trustedDomains.description': '这些域名上的链接打开时无需确认',

    'settings.security.trustedFolders.title': '受信任的文件夹',
    'settings.security.trustedFolders.description':
        '这些文件夹下的终端文件链接会直接在编辑器中打开，无需确认；保存时会写回原文件',

    'settings.files.exclude.title': '排除的文件',
    'settings.files.exclude.description': '在文件树中隐藏的 Glob 模式',

    'settings.git.diffExclude.title': '排除的 Git 差异文件',
    'settings.git.diffExclude.description':
        '在 Git 更改列表和“打开所有更改”中隐藏匹配的仓库相对路径。默认排除测试和翻译目录。使用源代码管理中的眼睛按钮可临时显示它们。支持 *、** 和 ?；这不会改变 Git 的跟踪状态。',

    'settings.files.maxFileBytes.title': '可编辑文件的最大大小',
    'settings.files.maxFileBytes.description':
        '更大的文件无法在编辑器中打开，搜索时也会跳过。请使用“用默认应用打开”。',

    'settings.projectStatus.ignoredChecks.title': '忽略的检查',
    'settings.projectStatus.ignoredChecks.description':
        '不计入 CI 汇总、侧边栏徽标和失败通知的检查',

    'settings.projectStatus.notifyAgentOnMerge.title': '拉取请求合并后通知 Agent',
    'settings.projectStatus.notifyAgentOnMerge.description':
        '无论通过项目状态、GitHub 还是他人合并，都会将“Pull request <link> has been merged.”作为新消息发送给会话的 Agent，每个拉取请求只发送一次。Agent 在自己的回合内合并时不会发送。',

    'settings.projectStatus.autoArchiveOnPullRequestSettled.title': '拉取请求合并或关闭后自动归档',
    'settings.projectStatus.autoArchiveOnPullRequestSettled.description':
        '会话的拉取请求合并或关闭、且 Agent 空闲后自动归档该会话。运行中的 Agent，或仍有后台 shell、subagent 在运行的会话，都不会被归档，也不会删除任何内容；可在已归档会话中找回。',

    'settings.projectStatus.notifications.enabled.title': '交付失败通知',
    'settings.projectStatus.notifications.enabled.description':
        'CI 检查或 Vercel 部署开始失败时发送通知',

    'settings.environmentMonitor.publicIpChanges.title': '公网 IP 变化',
    'settings.environmentMonitor.publicIpChanges.description':
        '本次启动期间公网出口 IP 变化时发送通知，并在状态栏持续提示。',

    'settings.environmentMonitor.expectedTimeZone.title': '预期系统时区',
    'settings.environmentMonitor.expectedTimeZone.description':
        '系统时区与你选择的时区不一致时提示。',

    'settings.environmentMonitor.mihomoRoutes.title': '域名通过 Mihomo 的路由',
    'settings.environmentMonitor.mihomoRoutes.description':
        '观察真实的 Mihomo 连接，并在指定域名未使用预期节点时提示。',

    'settings.agents.providers.title': 'Agent 提供方',
    'settings.agents.providers.description':
        '每个 Agent 提供方的启动命令、生命周期 Hook、对等消息和输出恢复',

    'settings.agents.longRunningShellCommands.title': '长期运行的后台命令',
    'settings.agents.longRunningShellCommands.description':
        '本来就会一直运行的命令，例如开发服务器。判断 Agent 这一轮是否结束时，Caxri 不会等它们退出',

    'settings.agents.sessionInstructions.title': '会话说明',
    'settings.agents.sessionInstructions.description':
        'Agent 启动时追加在它自己的系统提示词之后，让它知道自己运行在 Caxri 中，以及如何在另一个会话中开始工作。清空则不追加任何内容；修改只对之后启动的 Agent 生效',
    'settings.agents.suggestLifecycleHooks.title': '建议启用生命周期 Hook',
    'settings.agents.suggestLifecycleHooks.description':
        '提供方的 Agent 在终端中运行但未启用生命周期 Hook 时，提示启用。对话从不需要',

    'settings.agents.delegation.title': 'Agent 委派',
    'settings.agents.delegation.description': '命名的委派预设、调用方绑定和最大委派深度',

    'settings.agents.notifications.enabled.title': '系统通知',
    'settings.agents.notifications.enabled.description':
        '后台 Agent 需要处理时发送通知。在终端中运行的 Agent 还需启用提供方的生命周期 Hook；对话无需启用',

    'settings.agents.notifications.completionThresholdSeconds.title': '已完成轮次的时长阈值',
    'settings.agents.notifications.completionThresholdSeconds.description':
        '仅当已完成的 Agent 轮次运行至少这么久时才发送通知',
};

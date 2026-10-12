import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { agentActions as source } from '../en/agent-actions';

export const agentActions: TranslatedNamespace<typeof source> = {
    'agentActions.source.builtIn': '内置',
    'agentActions.source.project': '项目',
    'agentActions.source.global': '用户',
    'agentActions.source.legacy': '旧版',
    'agentActions.source.custom': '自定义',
    'agentActions.target.fallbackSession': '会话',
    'agentActions.target.fallbackTerminal': '终端',
    'agentActions.target.sharedLabel': '目标：{{provider}}；{{title}}',
    'agentActions.target.distinctLabel':
        '目标：{{provider}}；会话：{{session}}；终端：{{terminal}}',
    'agentActions.target.session': '会话：{{title}}',
    'agentActions.target.terminal': '终端：{{title}}',
    'agentActions.dialog.title': 'Agent 命令与 Skill',
    'agentActions.dialog.placeholder': '搜索 Skill 和斜杠命令，或输入 @ 引用会话…',
    'agentActions.dialog.recent': '最近使用',
    'agentActions.dialog.commands': '命令',
    'agentActions.dialog.skills': 'Skill',
    'agentActions.dialog.discovering': '正在发现 Skill…',
    'agentActions.dialog.partial':
        '部分命令或 Skill 不可用或超出了发现限制。其余可用的命令和 Skill 仍可使用。',
    'agentActions.dialog.interactionHint':
        '按 Enter 运行所选操作，按 Command+Enter 将其插入以便编辑。输入 @ 可插入对其他会话对话的引用。',
    'agentActions.dialog.manageInSettings': '在设置中管理…',
    'agentActions.dialog.needsArguments': '{{invocation}} 需要参数才能运行。',
    'agentActions.agentNotRunning': '所选 Agent 已不再运行。',
    'agentActions.sessions.heading': '会话',
    'agentActions.footer.run': '运行',
    'agentActions.footer.insert': '插入',
    'agentActions.empty.actions': '未找到 Agent 命令或 Skill。',
    'agentActions.empty.sessions': '没有其他包含 Agent 对话的会话匹配。',
    'agentActions.sendFailed': '无法发送 Agent 命令或 Skill',
    'agentActions.saveRecentFailed': '无法保存最近使用的 Agent 操作',
};

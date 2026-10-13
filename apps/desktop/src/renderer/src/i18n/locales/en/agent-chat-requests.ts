/**
 * Approval and question cards, the waiting status, and provider failure banners: the localized counterparts of the
 * English copy in `@caxri/protocol`'s `agent-chat-approval.ts` and `agent-chat-presentation.ts`.
 */
export const agentChatRequests = {
    // Approval buttons
    'agentChat.approval.run': 'Run',
    'agentChat.approval.allow': 'Allow',
    'agentChat.approval.applyChanges': 'Apply Changes',
    'agentChat.approval.startBuilding': 'Start Building',
    'agentChat.approval.alwaysAllow': 'Always Allow in This Chat',
    'agentChat.approval.deny': 'Deny',
    'agentChat.approval.keepPlanning': 'Keep Planning',

    // Request card headings
    'agentChat.request.title.network': 'Allow network access to {{host}}?',
    'agentChat.request.title.command': 'Run this command?',
    'agentChat.request.title.fileChange': 'Apply these file changes?',
    'agentChat.request.title.plan': 'Start with this plan?',
    'agentChat.request.title.mcp': 'Allow {{subject}} from {{server}}?',
    'agentChat.request.title.tool': 'Allow {{name}}?',
    'agentChat.request.title.actionSubject': 'Allow {{action}} {{subject}}?',
    'agentChat.request.title.action': 'Allow {{action}}?',
    'agentChat.request.title.questionOne': '{{provider}} has a question',
    'agentChat.request.title.questionOther': '{{provider}} has {{count}} questions',
    // What a tool approval asks to do, completing "Allow ... ?"
    'agentChat.request.action.agent': 'running agent',
    'agentChat.request.action.command': 'running',
    'agentChat.request.action.edit': 'editing',
    'agentChat.request.action.image': 'viewing image',
    'agentChat.request.action.list': 'listing',
    'agentChat.request.action.plan': 'updating plan',
    'agentChat.request.action.question': 'asking',
    'agentChat.request.action.read': 'reading',
    'agentChat.request.action.search': 'searching',
    'agentChat.request.action.skill': 'using skill',
    'agentChat.request.action.stop': 'stopping',
    'agentChat.request.action.thought': 'thinking',
    'agentChat.request.action.wait': 'waiting for agents',
    'agentChat.request.action.web': 'browsing',
    'agentChat.request.action.write': 'writing',

    // Status row while a turn is blocked on the user
    'agentChat.waiting.approval': 'Waiting for your approval',
    'agentChat.waiting.answer': 'Waiting for your answer',

    // Provider failure banner
    'agentChat.failure.executableNotFound':
        '{{provider}} is not installed or is not on your PATH. Install it, then retry.',
    'agentChat.failure.spawnFailed':
        '{{provider}} could not be started. Retry, or check that the {{provider}} CLI runs in a terminal.',
    'agentChat.failure.handshakeFailed':
        '{{provider}} started but did not respond. Retry, or update the {{provider}} CLI.',
    'agentChat.failure.processExited':
        '{{provider}} stopped unexpectedly. Retry to resume the conversation.',
    'agentChat.failure.resumeFailed': 'The previous conversation could not be resumed.',
    'agentChat.failure.conversationInUse':
        'This conversation is open in another {{provider}} app or window.',
    'agentChat.failure.unsupportedVersion':
        'This {{provider}} version does not support Chat. Update the {{provider}} CLI.',
} as const;

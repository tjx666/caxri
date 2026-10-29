/**
 * The translation key for the popup's live announcement of a request (`terminal` for a PTY Agent's open-only entry):
 * the provider and Session are named so a screen reader user knows which Chat asks before they move focus into the
 * card.
 */
export function agentChatWaitingAnnouncementKey(
    kind: 'question' | 'command' | 'fileChange' | 'tool' | 'terminal',
):
    | 'agentChat.waiting.announceQuestion'
    | 'agentChat.waiting.announceApproval'
    | 'agentChat.waiting.announceTerminal' {
    if (kind === 'terminal') return 'agentChat.waiting.announceTerminal';
    return kind === 'question'
        ? 'agentChat.waiting.announceQuestion'
        : 'agentChat.waiting.announceApproval';
}

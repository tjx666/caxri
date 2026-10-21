/**
 * The translation key for the popup's live announcement of a request: the provider and Session are named so a screen
 * reader user knows which Chat asks before they move focus into the card.
 */
export function agentChatWaitingAnnouncementKey(
    kind: 'question' | 'command' | 'fileChange' | 'tool',
): 'agentChat.waiting.announceQuestion' | 'agentChat.waiting.announceApproval' {
    return kind === 'question'
        ? 'agentChat.waiting.announceQuestion'
        : 'agentChat.waiting.announceApproval';
}

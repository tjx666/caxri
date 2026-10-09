/**
 * Unsent composer text per Chat Terminal. Switching tabs or Sessions unmounts a Chat's composer, and the draft must
 * survive that the way a Terminal's typed-but-unsent line does. A plain map rather than a store: nothing renders from
 * it, and it holds the user's own message text, which stays out of the `__caxriStores` debugging snapshot.
 */
const drafts = new Map<string, string>();

export function readAgentChatDraft(terminalId: string): string {
    return drafts.get(terminalId) ?? '';
}

export function writeAgentChatDraft(terminalId: string, text: string): void {
    if (text) drafts.set(terminalId, text);
    else drafts.delete(terminalId);
}

/**
 * The text left after a send was acknowledged. Typing continues while the send is in flight (a starting provider makes
 * that window long), so only the exact text that was sent is cleared; anything typed since stays.
 */
export function draftAfterSend(current: string, sent: string): string {
    return current === sent ? '' : current;
}

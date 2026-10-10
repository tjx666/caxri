import type { AgentChatImageInput } from '@caxri/protocol';

/**
 * Unsent composer text and images per Chat Terminal. Switching tabs or Sessions unmounts a Chat's composer, and the
 * draft must survive that the way a Terminal's typed-but-unsent line does. Plain maps rather than a store: nothing
 * renders from them, and they hold the user's own message, which stays out of the `__caxriStores` debugging snapshot.
 */
const drafts = new Map<string, string>();

export interface AgentChatAttachment {
    /**
     * Composer-local key, so removing one of two identical images removes the right chip.
     */
    id: string;
    image: AgentChatImageInput;
}

const attachments = new Map<string, AgentChatAttachment[]>();

export function readAgentChatDraft(terminalId: string): string {
    return drafts.get(terminalId) ?? '';
}

export function writeAgentChatDraft(terminalId: string, text: string): void {
    if (text) drafts.set(terminalId, text);
    else drafts.delete(terminalId);
}

export function readAgentChatAttachments(terminalId: string): AgentChatAttachment[] {
    return attachments.get(terminalId) ?? [];
}

export function writeAgentChatAttachments(
    terminalId: string,
    next: readonly AgentChatAttachment[],
): void {
    if (next.length > 0) attachments.set(terminalId, [...next]);
    else attachments.delete(terminalId);
}

/**
 * The text left after a send was acknowledged. Typing continues while the send is in flight (a starting provider makes
 * that window long), so only the exact text that was sent is cleared; anything typed since stays.
 */
export function draftAfterSend(current: string, sent: string): string {
    return current === sent ? '' : current;
}

/**
 * The attachments left after a send was acknowledged: the ones sent are removed, any added since stay.
 */
export function attachmentsAfterSend(
    current: readonly AgentChatAttachment[],
    sent: readonly AgentChatAttachment[],
): AgentChatAttachment[] {
    const sentIds = new Set(sent.map((attachment) => attachment.id));
    return current.filter((attachment) => !sentIds.has(attachment.id));
}

/**
 * Inserts `text` over the selection `[start, end)`, padded with a space wherever it would otherwise run into a
 * neighboring word, and always followed by one so the user can keep typing. Returns the new draft and where the caret
 * goes.
 */
export function draftWithInsertion(
    draft: string,
    start: number,
    end: number,
    text: string,
): { draft: string; caret: number } {
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const leading = before && !/\s$/u.test(before) ? ' ' : '';
    const trailing = /^\s/u.test(after) ? '' : ' ';
    const inserted = `${leading}${text}${trailing}`;
    return { draft: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

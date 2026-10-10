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
    /**
     * The picked or dropped file's name, for the chip's alt text. A pasted screenshot often has only a generic name
     * (`image.png`); an empty one falls back to the chip's position.
     */
    name?: string;
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

/**
 * The chip's alt text: the file name when the attachment has one, otherwise its position.
 */
export function agentChatAttachmentLabel(
    attachment: Pick<AgentChatAttachment, 'name'>,
    index: number,
): string {
    if (attachment.name) return attachment.name;
    return `Attachment ${index + 1}`;
}

/**
 * The warning for a paste that would push the draft past `maxLength`, or `undefined` when it fits. Pasting
 * `pastedLength` characters replaces a selection of `selectedLength` in a draft of `currentLength`; past the limit the
 * textarea's `maxLength` cuts the paste silently, so the composer says so.
 */
export function agentChatPasteTruncationWarning(
    {
        currentLength,
        pastedLength,
        selectedLength,
    }: { currentLength: number; pastedLength: number; selectedLength: number },
    maxLength: number,
): string | undefined {
    if (pastedLength === 0 || currentLength - selectedLength + pastedLength <= maxLength)
        return undefined;
    return `Pasted text was cut off at the ${maxLength.toLocaleString('en-US')}-character message limit`;
}

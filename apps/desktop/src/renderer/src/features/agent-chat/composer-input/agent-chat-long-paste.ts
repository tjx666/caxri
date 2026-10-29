import { isLongPasteWithinLimit, MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * What a text paste into the composer does: land in the input, be saved to a file the message cites, or be refused
 * because even a saved file would exceed the local file safety limit (`too-large`) or the message has no room left for
 * the file's reference (`no-room`).
 */
export type AgentChatPasteDisposition = 'file' | 'inline' | 'no-room' | 'too-large';

/**
 * Upper bound on a saved paste's reference (`formatLongPasteReference`): about 300 characters of fixed text plus the
 * file path, which stays well under 1,024 characters inside the user data directory.
 */
const LONG_PASTE_REFERENCE_ALLOWANCE = 2048;

/**
 * Decides where `pasted` goes when it replaces a selection of `selectedLength` in a draft of `currentLength`. Text past
 * `threshold` (`agentChat.longPasteThreshold`) becomes a file so a log or a dump does not bury the message, and so does
 * any paste the message limit would otherwise cut, since the editor's length limit drops the overflow silently. Raising
 * the threshold is how a user pastes long text as is; it never lets a paste past the message limit be cut.
 */
export function agentChatPasteDisposition({
    currentLength,
    pasted,
    selectedLength,
    threshold,
}: {
    currentLength: number;
    pasted: string;
    selectedLength: number;
    threshold: number;
}): AgentChatPasteDisposition {
    if (
        pasted.length <= threshold &&
        currentLength - selectedLength + pasted.length <= MAX_AGENT_CHAT_MESSAGE_LENGTH
    )
        return 'inline';
    if (!isLongPasteWithinLimit(pasted)) return 'too-large';
    // The reference is inserted programmatically, so the input's `maxLength` would not stop it overflowing the message.
    return currentLength - selectedLength + LONG_PASTE_REFERENCE_ALLOWANCE <=
        MAX_AGENT_CHAT_MESSAGE_LENGTH
        ? 'file'
        : 'no-room';
}

/**
 * Whether a paste saved as a file could have gone into the message as text instead: it fits the message limit in place
 * of the selection it replaced. Only then does the saved-paste notice offer Paste as Text.
 */
export function canAgentChatPasteFitAsText({
    currentLength,
    pasted,
    selectedLength,
}: {
    currentLength: number;
    pasted: string;
    selectedLength: number;
}): boolean {
    return currentLength - selectedLength + pasted.length <= MAX_AGENT_CHAT_MESSAGE_LENGTH;
}

/**
 * The draft with a saved paste's `reference` put back as the pasted `text`, or `undefined` when the reference is no
 * longer in the draft (the user removed or edited it) or the text would push the message past its limit.
 */
export function draftWithLongPasteAsText(
    draft: string,
    reference: string,
    text: string,
): string | undefined {
    const index = draft.indexOf(reference);
    if (index === -1) return undefined;
    const next = `${draft.slice(0, index)}${text}${draft.slice(index + reference.length)}`;
    return next.length <= MAX_AGENT_CHAT_MESSAGE_LENGTH ? next : undefined;
}

/**
 * The draft after a plain-text paste (Cmd+Shift+V) of `text` over the selection `[start, end)`, which skips the long
 * paste file entirely, with where the caret goes; `undefined` when the result would exceed the message limit, since a
 * programmatic insert is not cut by the input's `maxLength`.
 */
export function draftWithPlainPaste(
    draft: string,
    start: number,
    end: number,
    text: string,
): { caret: number; draft: string } | undefined {
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    if (next.length > MAX_AGENT_CHAT_MESSAGE_LENGTH) return undefined;
    return { caret: start + text.length, draft: next };
}

/**
 * What a saved paste's chip says, in the composer and in a sent message: `Pasted text · N lines`, with the full summary
 * and character count for its tooltip and screen readers. `isClickable` adds that the chip opens the original.
 */
export function agentChatLongPasteChipText(
    { characterCount, lineCount }: { characterCount: number; lineCount: number },
    isClickable: boolean,
    t: Translate,
): { aria: string; detail: string; label: string } {
    const label =
        lineCount === 1
            ? t('agentChat.longPaste.chipOne')
            : t('agentChat.longPaste.chipOther', { count: lineCount });
    const detail = t(
        isClickable ? 'agentChat.longPaste.detail' : 'agentChat.longPaste.detailStatic',
        { characters: characterCount, summary: label },
    );
    return { aria: t('agentChat.longPaste.label', { summary: label }), detail, label };
}

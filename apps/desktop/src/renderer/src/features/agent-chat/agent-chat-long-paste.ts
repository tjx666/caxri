import {
    AGENT_CHAT_LONG_PASTE_THRESHOLD,
    isLongPasteWithinLimit,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
} from '@caxri/protocol';

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
 * {@link AGENT_CHAT_LONG_PASTE_THRESHOLD} becomes a file so a log or a dump does not bury the message, and so does any
 * paste the message limit would otherwise cut, since the textarea's `maxLength` drops the overflow silently.
 */
export function agentChatPasteDisposition({
    currentLength,
    pasted,
    selectedLength,
}: {
    currentLength: number;
    pasted: string;
    selectedLength: number;
}): AgentChatPasteDisposition {
    if (
        pasted.length <= AGENT_CHAT_LONG_PASTE_THRESHOLD &&
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

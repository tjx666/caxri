/**
 * One user message the Messages sheet lists: where it sits in the Conversation's rows, and the start of its words.
 */
export interface ConversationMessageMark {
    id: string;
    /**
     * The row's index in the list's entries, which `scrollToIndex` takes.
     */
    index: number;
    /**
     * The message's start on one line, or `''` while it has no words to show (a message of images alone).
     */
    preview: string;
}

/**
 * The longest preview a sheet row holds. Two lines of a phone row fit about this much; the row clamps the rest.
 */
const PREVIEW_LENGTH = 160;

/**
 * Whether the Messages control shows: a Conversation with one message has nowhere to jump back to, so it appears from
 * the second, as Desktop's message rail does (`isAgentChatMessageRailShown`). It stops at the second message, since
 * every streamed patch asks again.
 */
export const isConversationMessageIndexShown = <Entry>(
    entries: readonly Entry[],
    previewOf: (entry: Entry) => string | undefined,
): boolean => {
    let count = 0;
    for (const entry of entries) {
        if (previewOf(entry) === undefined) continue;
        count += 1;
        if (count >= 2) return true;
    }
    return false;
};

/**
 * A message's start on one line: whitespace collapsed and cut to {@link PREVIEW_LENGTH}. Only the message's start is
 * read, so a pasted log of thousands of lines costs no more than a sentence.
 */
export const conversationMessagePreview = (text: string): string => {
    const line = text
        .slice(0, PREVIEW_LENGTH * 4)
        .replaceAll(/\s+/gu, ' ')
        .trim();
    return line.length <= PREVIEW_LENGTH ? line : `${line.slice(0, PREVIEW_LENGTH - 1)}…`;
};

/**
 * The user messages among `entries`, in order. `previewOf` returns a row's words when the row is a user message and
 * `undefined` for every other row; the caller knows its own entry shape.
 */
export const conversationMessageMarks = <Entry extends { id: string }>(
    entries: readonly Entry[],
    previewOf: (entry: Entry) => string | undefined,
): ConversationMessageMark[] => {
    const marks: ConversationMessageMark[] = [];
    for (const [index, entry] of entries.entries()) {
        const text = previewOf(entry);
        if (text === undefined) continue;
        marks.push({ id: entry.id, index, preview: conversationMessagePreview(text) });
    }
    return marks;
};

/**
 * Which message the reader is in: the last one at or above the first row in view, so a reader partway through a long
 * reply stands in the turn that message started. The last message while the list is at its end, where the final
 * exchange may sit below the first row in view; the first message while every message is still below it.
 */
export const activeConversationMessage = (
    marks: readonly ConversationMessageMark[],
    firstVisibleIndex: number,
    isAtEnd: boolean,
): number => {
    if (marks.length === 0) return -1;
    if (isAtEnd) return marks.length - 1;
    let active = 0;
    for (const [position, mark] of marks.entries()) {
        if (mark.index > firstVisibleIndex) break;
        active = position;
    }
    return active;
};

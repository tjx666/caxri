import type { AgentChatItem } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

/**
 * Shell-style prompt recall for the Chat composer: ArrowUp on an empty input walks back through the prompts this Chat
 * sent, ArrowDown walks forward and empties the input past the newest one. The history is derived from the Chat's own
 * `userMessage` items on every keypress, so there is nothing to persist or keep in sync, and it survives a restart
 * because the conversation does. This follows t3code's `composerPromptHistory`.
 */
export interface AgentChatPromptHistoryEntry {
    /**
     * The `userMessage` item id, so the position survives entries arriving while the user browses.
     */
    id: string;
    prompt: string;
}

/**
 * The prompt being shown. `recalled` is the text put into the input; once the input no longer matches it, the user has
 * edited or sent it and browsing is over.
 */
export interface AgentChatPromptHistoryPosition {
    entryId: string;
    recalled: string;
}

export type AgentChatPromptHistoryDirection = 'backward' | 'forward';

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one, like shell `HISTCONTROL=ignoredups`, and an
 * image-only message has no text to recall.
 */
export function agentChatPromptHistory(
    items: readonly AgentChatItem[] | undefined,
): AgentChatPromptHistoryEntry[] {
    const entries: AgentChatPromptHistoryEntry[] = [];
    if (!items) return entries;
    for (const item of items) {
        if (item.type !== 'userMessage') continue;
        // Recall brings back the user's words; the files and folders the message cited are not part of the prompt.
        const prompt = parseAgentChatPathReferences(item.text).text.trim();
        if (!prompt) continue;
        if (entries.at(-1)?.prompt === prompt) entries.pop();
        entries.push({ id: item.id, prompt });
    }
    return entries;
}

/**
 * Which way an arrow key moves through the history, or `undefined` when it should move the caret as usual. Only a bare
 * ArrowUp or ArrowDown counts, never while an IME composes, and only with the caret collapsed on the input's first line
 * (backward) or last line (forward), so a multi-line prompt can still be navigated line by line.
 */
export function agentChatPromptHistoryDirection(
    event: {
        key: string;
        altKey: boolean;
        ctrlKey: boolean;
        isComposing: boolean;
        metaKey: boolean;
        shiftKey: boolean;
    },
    input: { selectionEnd: number; selectionStart: number; value: string },
): AgentChatPromptHistoryDirection | undefined {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
        return undefined;
    if (input.selectionStart !== input.selectionEnd) return undefined;
    if (event.key === 'ArrowUp')
        return input.value.slice(0, input.selectionStart).includes('\n') ? undefined : 'backward';
    if (event.key === 'ArrowDown')
        return input.value.includes('\n', input.selectionEnd) ? undefined : 'forward';
    return undefined;
}

/**
 * The next prompt to show, or `undefined` when the key should fall through. Backward starts only from an empty input
 * and stops at the oldest entry; forward past the newest entry empties the input and ends browsing. An input that no
 * longer matches the recalled prompt is a draft of the user's own, so browsing starts over.
 */
export function stepAgentChatPromptHistory({
    current,
    direction,
    entries,
    position,
}: {
    current: string;
    direction: AgentChatPromptHistoryDirection;
    entries: readonly AgentChatPromptHistoryEntry[];
    position: AgentChatPromptHistoryPosition | undefined;
}): { position: AgentChatPromptHistoryPosition | undefined; prompt: string } | undefined {
    const activeIndex = position?.recalled === current ? activeEntryIndex(entries, position) : -1;
    if (direction === 'backward') {
        if (activeIndex === -1 && current.length > 0) return undefined;
        const index = (activeIndex === -1 ? entries.length : activeIndex) - 1;
        return index < 0 ? undefined : recall(entries, index);
    }
    if (activeIndex === -1) return undefined;
    // Past the newest prompt the input empties, the way a shell returns to its blank line.
    if (activeIndex + 1 >= entries.length) return { position: undefined, prompt: '' };
    return recall(entries, activeIndex + 1);
}

function recall(
    entries: readonly AgentChatPromptHistoryEntry[],
    index: number,
): { position: AgentChatPromptHistoryPosition; prompt: string } {
    const { id, prompt } = entries[index];
    return { position: { entryId: id, recalled: prompt }, prompt };
}

/**
 * The id first; a later identical prompt collapses the recalled entry into a newer id, so fall back to the newest entry
 * with the same text.
 */
function activeEntryIndex(
    entries: readonly AgentChatPromptHistoryEntry[],
    position: AgentChatPromptHistoryPosition,
): number {
    const byId = entries.findIndex((entry) => entry.id === position.entryId);
    if (byId !== -1) return byId;
    return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

import type { AgentChatItem } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

/**
 * Shell-style prompt recall for the Chat composer: ArrowUp on its first line walks back through the prompts this Chat
 * sent, ArrowDown walks forward and restores the unsent draft past the newest one. The history is derived from the
 * Chat's own `userMessage` items on every keypress, so there is nothing to persist or keep in sync, and it survives a
 * restart because the conversation does. This follows t3code's `composerPromptHistory`.
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
    /**
     * The unsent text to put back after walking past the newest prompt.
     */
    draft?: string;
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
 * The next prompt to show, or `undefined` when the key should fall through. The caller checks caret boundaries before
 * stepping. Browsing saves the unsent text rather than discarding it, and forward past the newest entry puts it back.
 * Editing a recalled prompt starts a fresh browse with that edited text as the return draft.
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
        const index = (activeIndex === -1 ? entries.length : activeIndex) - 1;
        return index < 0
            ? undefined
            : recall(entries, index, activeIndex === -1 ? current : position?.draft);
    }
    if (activeIndex === -1) return undefined;
    if (activeIndex + 1 >= entries.length)
        return { position: undefined, prompt: position?.draft ?? '' };
    return recall(entries, activeIndex + 1, position?.draft);
}

function recall(
    entries: readonly AgentChatPromptHistoryEntry[],
    index: number,
    draft?: string,
): { position: AgentChatPromptHistoryPosition; prompt: string } {
    const { id, prompt } = entries[index];
    return { position: { entryId: id, recalled: prompt, ...(draft && { draft }) }, prompt };
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

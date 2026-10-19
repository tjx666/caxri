import type { AgentChatItem } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

import type { SuggestionMenuKeyAction } from '../../lib/suggestion-options';

/**
 * Prompt recall for the Chat composer, as LobeHub's chat input does it: ArrowUp in an empty input opens a list of the
 * prompts this Chat sent above the composer, newest at the bottom nearest the input, and previews the highlighted one
 * in the input's placeholder. Enter or Tab puts it in the input without sending; Escape, ArrowDown past the newest, or
 * typing closes the list. The history is derived from the Chat's own `userMessage` items when the list opens, so there
 * is nothing to persist or keep in sync, and it survives a restart because the conversation does.
 */
export interface AgentChatPromptHistoryEntry {
    /**
     * The `userMessage` item id, a stable row key.
     */
    id: string;
    prompt: string;
}

/**
 * Rows the list keeps, newest first: enough to reach back through a long session without the list becoming a log.
 */
export const MAX_AGENT_CHAT_PROMPT_HISTORY = 50;

/**
 * Oldest first, at most {@link MAX_AGENT_CHAT_PROMPT_HISTORY}. A prompt sent again moves to its newest position rather
 * than listing twice, and an image-only message has no text to recall.
 */
export function agentChatPromptHistory(
    items: readonly AgentChatItem[] | undefined,
): AgentChatPromptHistoryEntry[] {
    const newest = new Map<string, string>();
    const chatItems = items ?? [];
    for (const item of chatItems) {
        if (item.type !== 'userMessage') continue;
        // Recall brings back the user's words; the files and folders the message cited are not part of the prompt.
        const prompt = parseAgentChatPathReferences(item.text).text.trim();
        if (!prompt) continue;
        newest.delete(prompt);
        newest.set(prompt, item.id);
    }
    return [...newest]
        .slice(-MAX_AGENT_CHAT_PROMPT_HISTORY)
        .map(([prompt, id]) => ({ id, prompt }));
}

/**
 * Whether a key opens the list: a bare ArrowUp, outside IME composition, in an input holding nothing but whitespace. A
 * draft of any length keeps ArrowUp for the caret, so a multi-line prompt is still navigated line by line.
 */
export function shouldOpenAgentChatPromptHistory(
    event: {
        key: string;
        altKey: boolean;
        ctrlKey: boolean;
        isComposing: boolean;
        metaKey: boolean;
        shiftKey: boolean;
    },
    draft: string,
): boolean {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
        return false;
    return event.key === 'ArrowUp' && draft.trim() === '';
}

/**
 * The open list's next highlighted row after a key, `'fill'` to put the highlighted prompt in the input, or `'close'`.
 * It stops at the oldest row rather than wrapping, and ArrowDown on the newest closes the list, the way a shell returns
 * to its blank line. Any key the list does not own closes it and still reaches the input.
 */
export function stepAgentChatPromptHistory(
    action: SuggestionMenuKeyAction | undefined,
    activeIndex: number,
    count: number,
): number | 'close' | 'fill' {
    switch (action) {
        case 'previous': {
            return Math.max(activeIndex - 1, 0);
        }
        case 'next': {
            return activeIndex + 1 >= count ? 'close' : activeIndex + 1;
        }
        case 'choose':
        case 'complete': {
            return 'fill';
        }
        case 'dismiss':
        case undefined: {
            return 'close';
        }
    }
}

/**
 * A prompt on one line, for a list row and the input's placeholder preview.
 */
export function agentChatPromptPreview(prompt: string): string {
    return prompt.replaceAll(/\s+/gu, ' ').trim();
}

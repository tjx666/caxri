import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

import type { AgentChatItem } from '@caxri/protocol';

import type { AgentChatPromptHistoryPosition } from '../agent-chat-prompt-history';
import {
    agentChatPromptHistory,
    agentChatPromptHistoryDirection,
    stepAgentChatPromptHistory,
} from '../agent-chat-prompt-history';

/**
 * ArrowUp/ArrowDown recall of the prompts this Chat sent (see `agent-chat-prompt-history`). The position is a ref: it
 * only matters to the next keypress, and the input text the step writes is what re-renders.
 */
export function useAgentChatPromptHistory({
    draft,
    hasAttachments,
    items,
    setDraft,
}: {
    draft: string;
    /**
     * An attached image makes the input not empty: recalling an old prompt into it would send that prompt with the new
     * image, which is never what ArrowUp meant.
     */
    hasAttachments: boolean;
    items: readonly AgentChatItem[] | undefined;
    setDraft: (update: (current: string) => string) => void;
}) {
    const position = useRef<AgentChatPromptHistoryPosition | undefined>(undefined);
    /**
     * Runs before the command menu's keys. An open menu keeps the arrows for its own rows unless the input still shows
     * a recalled prompt: recalling a sent `/command` opens the menu, and the next ArrowUp should keep walking back.
     */
    const didHandleKey = (
        event: KeyboardEvent<HTMLTextAreaElement>,
        isMenuOpen: boolean,
    ): boolean => {
        if (hasAttachments) return false;
        // A typed draft with no recall in progress never steps, so skip building the history.
        if (!position.current && draft.length > 0) return false;
        if (isMenuOpen && position.current?.recalled !== draft) return false;
        const direction = agentChatPromptHistoryDirection(
            {
                key: event.key,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                isComposing: event.nativeEvent.isComposing,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
            },
            event.currentTarget,
        );
        if (!direction) return false;
        const step = stepAgentChatPromptHistory({
            current: draft,
            direction,
            entries: agentChatPromptHistory(items),
            position: position.current,
        });
        if (!step) return false;
        event.preventDefault();
        position.current = step.position;
        setDraft(() => step.prompt);
        // A controlled value change leaves the caret where it was; put it at the end the way a shell does, which is
        // also where the next ArrowUp or ArrowDown continues from.
        const textarea = event.currentTarget;
        requestAnimationFrame(() =>
            textarea.setSelectionRange(step.prompt.length, step.prompt.length),
        );
        return true;
    };
    return { didHandleKey };
}

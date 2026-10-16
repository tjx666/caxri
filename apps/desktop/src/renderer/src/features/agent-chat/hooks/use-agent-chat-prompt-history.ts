import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

import type { AgentChatItem } from '@caxri/protocol';

import { isImeComposing } from '../../../lib/ime';
import type { AgentChatPromptHistoryPosition } from '../agent-chat-prompt-history';
import {
    agentChatPromptHistory,
    agentChatPromptHistoryDirection,
    stepAgentChatPromptHistory,
} from '../agent-chat-prompt-history';
import { isAgentChatPromptHistoryBoundary } from '../agent-chat-prompt-history-layout';

/**
 * ArrowUp/ArrowDown recall of the prompts this Chat sent (see `agent-chat-prompt-history`). The position is a ref: it
 * only matters to the next keypress, and the input text the step writes is what re-renders.
 */
export function useAgentChatPromptHistory({
    draft,
    hasAttachments,
    isEditing,
    items,
    setDraft,
}: {
    draft: string;
    /**
     * An attached image makes the input not empty: recalling an old prompt into it would send that prompt with the new
     * image, which is never what ArrowUp meant.
     */
    hasAttachments: boolean;
    /**
     * "Edit from here" owns the input: recalling a sent prompt would overwrite the message being edited.
     */
    isEditing: boolean;
    items: readonly AgentChatItem[] | undefined;
    setDraft: (update: (current: string) => string) => void;
}) {
    const position = useRef<AgentChatPromptHistoryPosition | undefined>(undefined);
    const returnSelection = useRef<
        | { start: number; end: number; direction: HTMLTextAreaElement['selectionDirection'] }
        | undefined
    >(undefined);
    /**
     * Runs before the command menu's keys. An open menu keeps the arrows for its own rows unless the input still shows
     * a recalled prompt: recalling a sent `/command` opens the menu, and the next ArrowUp should keep walking back.
     */
    const didHandleKey = (
        event: KeyboardEvent<HTMLTextAreaElement>,
        isMenuOpen: boolean,
    ): boolean => {
        if (hasAttachments || isEditing) return false;
        if (isMenuOpen && position.current?.recalled !== draft) return false;
        const direction = agentChatPromptHistoryDirection(
            {
                key: event.key,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                isComposing: isImeComposing(event),
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
        if (!step || !isAgentChatPromptHistoryBoundary(event.currentTarget, direction))
            return false;
        event.preventDefault();
        const textarea = event.currentTarget;
        if (position.current?.recalled !== draft)
            returnSelection.current = {
                start: textarea.selectionStart,
                end: textarea.selectionEnd,
                direction: textarea.selectionDirection,
            };
        const selection = step.position ? undefined : returnSelection.current;
        position.current = step.position;
        if (!step.position) returnSelection.current = undefined;
        setDraft(() => step.prompt);
        requestAnimationFrame(() => {
            if (!textarea.isConnected || textarea.value !== step.prompt) return;
            textarea.setSelectionRange(
                selection?.start ?? step.prompt.length,
                selection?.end ?? step.prompt.length,
                selection?.direction,
            );
        });
        return true;
    };
    return { didHandleKey };
}

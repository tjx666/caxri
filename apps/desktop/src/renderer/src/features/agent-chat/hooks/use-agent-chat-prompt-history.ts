import type { RefObject } from 'react';
import { useEffect, useId, useState } from 'react';

import type { AgentChatItem } from '@caxri/protocol';

import { isImeComposing } from '../../../lib/ime';
import type { SuggestionOption } from '../../../lib/suggestion-options';
import { suggestionMenuKeyAction, suggestionOptionId } from '../../../lib/suggestion-options';
import type {
    AgentChatComposerInput,
    AgentChatComposerKeyEvent,
} from '../composer/agent-chat-composer-view';
import type { AgentChatPromptHistoryEntry } from '../composer-input/agent-chat-prompt-history';
import {
    agentChatPromptHistory,
    agentChatPromptPreview,
    shouldOpenAgentChatPromptHistory,
    stepAgentChatPromptHistory,
} from '../composer-input/agent-chat-prompt-history';

/**
 * The composer's prompt history list (see `agent-chat-prompt-history`). The rows are read once when the list opens, so
 * a reply arriving while the user browses never moves the highlighted row.
 */
export function useAgentChatPromptHistory({
    draft,
    hasAttachments,
    inputReference,
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
    inputReference: RefObject<AgentChatComposerInput | null>;
    /**
     * "Edit from here" owns the input: recalling a sent prompt would overwrite the message being edited.
     */
    isEditing: boolean;
    items: readonly AgentChatItem[] | undefined;
    setDraft: (update: (current: string) => string) => void;
}) {
    const listId = useId();
    const [open, setOpen] = useState<{
        activeIndex: number;
        entries: readonly AgentChatPromptHistoryEntry[];
    }>();
    const close = (): void => setOpen(undefined);
    const fill = (index: number): void => {
        const entry = open?.entries[index];
        setOpen(undefined);
        if (!entry) return;
        setDraft(() => entry.prompt);
        // A controlled value change leaves the caret where it was; put it at the end, where the user continues typing.
        const input = inputReference.current;
        input?.focus();
        requestAnimationFrame(() =>
            input?.setSelectionRange(entry.prompt.length, entry.prompt.length),
        );
    };
    /**
     * Runs before the command and `@` menus' keys; an open menu keeps ArrowUp for its own rows. Returns whether the key
     * was the history's, so the composer skips its own handling.
     */
    const didHandleKey = (event: AgentChatComposerKeyEvent, isMenuOpen: boolean): boolean => {
        const isComposing = isImeComposing(event);
        if (!open) {
            if (isMenuOpen || hasAttachments || isEditing) return false;
            const opens = shouldOpenAgentChatPromptHistory(
                {
                    key: event.key,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    isComposing,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey,
                },
                draft,
            );
            if (!opens) return false;
            const entries = agentChatPromptHistory(items);
            if (entries.length === 0) return false;
            event.preventDefault();
            setOpen({ activeIndex: entries.length - 1, entries });
            return true;
        }
        if (isComposing) return false;
        const step = stepAgentChatPromptHistory(
            suggestionMenuKeyAction(event),
            open.activeIndex,
            open.entries.length,
        );
        if (step === 'close') {
            close();
            // Escape and ArrowDown were the list's; any other key closes it and still types.
            if (event.key !== 'Escape' && event.key !== 'ArrowDown') return false;
        } else if (step === 'fill') fill(open.activeIndex);
        else setOpen({ ...open, activeIndex: step });
        event.preventDefault();
        return true;
    };
    const suggestions: SuggestionOption[] =
        open?.entries.map(({ id, prompt }) => ({
            key: id,
            label: agentChatPromptPreview(prompt),
            isLabelLiteral: false,
        })) ?? [];
    const active = open?.entries[open.activeIndex];
    const activeOptionId = active && suggestionOptionId(listId, active.id);
    /**
     * The rows never take focus, so the active one is scrolled into view by hand; the list opens on its newest row at
     * the bottom, below the oldest ones that overflow its height.
     */
    useEffect(() => {
        if (!activeOptionId) return;
        document
            .querySelector(`#${CSS.escape(activeOptionId)}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);
    return {
        activeIndex: open?.activeIndex ?? -1,
        chooseAt: fill,
        close,
        didHandleKey,
        highlight: (index: number) =>
            setOpen((current) => current && { ...current, activeIndex: index }),
        inputAria: open && {
            'aria-activedescendant': activeOptionId,
            'aria-autocomplete': 'list' as const,
            'aria-controls': listId,
        },
        isOpen: open !== undefined,
        listId,
        /**
         * The highlighted prompt on one line, shown as the empty input's placeholder while the list is open.
         */
        preview: active && agentChatPromptPreview(active.prompt),
        suggestions,
    };
}

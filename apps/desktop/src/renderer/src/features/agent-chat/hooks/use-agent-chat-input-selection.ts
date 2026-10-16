import { useLayoutEffect, useRef } from 'react';

import { markAgentChatComposerSelectionPlaced } from '../agent-chat-composer-caret';

interface InputSelection {
    direction: HTMLTextAreaElement['selectionDirection'];
    end: number;
    start: number;
    text: string;
    textarea: HTMLTextAreaElement;
}

function applySelection(selection: InputSelection): void {
    const { textarea, text, start, end, direction } = selection;
    if (!textarea.isConnected || textarea.value !== text) return;
    textarea.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length), direction);
    markAgentChatComposerSelectionPlaced(textarea);
}

/**
 * Restores the selection in the text commit, before another edit can select or replace the input. A later animation
 * frame can overwrite that next selection and append text meant to replace the draft.
 */
export function useAgentChatInputSelection(draft: string) {
    const pending = useRef<InputSelection | undefined>(undefined);
    useLayoutEffect(() => {
        const selection = pending.current;
        pending.current = undefined;
        if (selection) applySelection(selection);
    }, [draft]);
    return (selection: InputSelection): void => {
        pending.current = undefined;
        if (selection.textarea.value === selection.text) applySelection(selection);
        else pending.current = selection;
    };
}

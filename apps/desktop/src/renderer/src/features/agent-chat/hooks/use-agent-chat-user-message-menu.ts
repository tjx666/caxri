import type { MouseEvent, RefObject } from 'react';
import { useState } from 'react';

import { useContextMenu } from '../../../hooks/use-context-menu';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { agentChatUserMessageMenu } from '../agent-chat-user-message-menu';
import { useAgentChatEdit } from './use-agent-chat-edit';

/**
 * The selected text when the document selection lies inside `container`, so a right-click on a highlighted phrase
 * copies that phrase and a right-click elsewhere in the message copies all of it.
 */
function selectionInside(container: HTMLElement | null): string {
    const selection = getSelection();
    if (!container || !selection || selection.isCollapsed) return '';
    const { anchorNode, focusNode } = selection;
    if (!anchorNode || !focusNode) return '';
    return container.contains(anchorNode) && container.contains(focusNode)
        ? selection.toString()
        : '';
}

/**
 * Copies from the menu with the same confirmation a keyboard copy out of the transcript raises, since a native menu
 * entry, unlike the hover row's Copy button, has no check mark to turn into.
 */
function copyFromMenu(value: string, isSelection: boolean): void {
    // eslint-disable-next-line no-void -- tryCommand reports a failed copy through the toast
    void tryCommand('Unable to copy the message', async () => {
        await navigator.clipboard.writeText(value);
        pushToast('success', isSelection ? 'Selection copied' : 'Message copied');
    });
}

/**
 * A user message's Fork in-flight state, shared by its hover-row button and its right-click menu so neither can start a
 * second fork, and the `onContextMenu` handler that opens the menu built by {@link agentChatUserMessageMenu}.
 */
export function useAgentChatUserMessageMenu({
    container,
    id,
    text,
}: {
    container: RefObject<HTMLElement | null>;
    id: string;
    text: string;
}): { isForking: boolean; fork: () => void; onContextMenu: (event: MouseEvent) => void } {
    const edit = useAgentChatEdit();
    const [isForking, setIsForking] = useState(false);
    const fork = (): void => {
        if (!edit || isForking) return;
        setIsForking(true);
        // eslint-disable-next-line no-void -- `forkAgentChat` reports its own failure through a toast
        void edit.fork(id, text).finally(() => setIsForking(false));
    };
    const onContextMenu = useContextMenu(() => {
        const selectedText = selectionInside(container.current);
        return agentChatUserMessageMenu({
            text,
            selectedText,
            edit: edit?.availability(id),
            fork: edit?.forkAvailability(id),
            restore: edit?.restore?.availability(id),
            isForking,
            onCopy: (value) => copyFromMenu(value, value !== text),
            onEdit: () => edit?.startEdit(id, text),
            onFork: fork,
            onRestore: () => edit?.restore?.run(id),
        });
    });
    return { isForking, fork, onContextMenu };
}

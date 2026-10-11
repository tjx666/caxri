import type { ClipboardEvent, DragEvent } from 'react';
import { useState } from 'react';

import { MAX_AGENT_CHAT_MESSAGE_LENGTH } from '@caxri/protocol';

import { hasTerminalDraggedPath, PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import { pushToast } from '../../../stores/toasts';
import { EDITOR_PATH_DRAG_TYPE } from '../../workbench/pane-drop-zone';
import { agentChatPasteTruncationWarning } from '../agent-chat-drafts';
import { agentChatImageFiles, agentChatImagesUnsupportedMessage } from '../agent-chat-images';

/**
 * Whether a drag carries something the composer takes: files from another application, a Files entry, an Editor tab, or
 * a Project. Only `types` is readable before the drop. An Editor tab dragged with Option is left to the pane, which
 * places it, as Option does over a Terminal.
 */
function isComposerDrag(event: DragEvent): boolean {
    const { types } = event.dataTransfer;
    return (
        hasTerminalDraggedPath(event) ||
        (types.includes(EDITOR_PATH_DRAG_TYPE) && !event.altKey) ||
        types.includes(PROJECT_PATH_DRAG_TYPE)
    );
}

export type AgentChatDropHandlers = ReturnType<typeof useAgentChatFileInput>['dropHandlers'];

/**
 * Paste and drag-and-drop handlers for the composer. Images go to `add` when the provider accepts them; every other
 * dropped file, Files entry, Editor tab, or Project is cited by path through `insertPaths`, as a drop into a Terminal
 * is. `insertPaths` receives the drop and the files it should cite. A pasted image the provider cannot take has no path
 * to cite, so it says why in an info toast instead of silently doing nothing. Pasted text the message limit would cut
 * says so in a warning, since the textarea's `maxLength` cuts it silently.
 */
export function useAgentChatFileInput({
    add,
    insertPaths,
    isImageInputEnabled,
    providerName,
}: {
    add: (files: readonly File[]) => Promise<void>;
    insertPaths: (event: DragEvent, files: readonly File[]) => void;
    isImageInputEnabled: boolean;
    /**
     * The provider catalog's display name, for the toast that says it takes no images.
     */
    providerName: string;
}) {
    const [isDragOver, setDragOver] = useState(false);
    const attach = (files: readonly File[]): void => {
        // eslint-disable-next-line no-void -- add reports unreadable or rejected images through toasts
        if (isImageInputEnabled && files.length > 0) void add(files);
    };
    return {
        isDragOver,
        dropHandlers: {
            onDragLeave: (event: DragEvent) => {
                // Leaving for a child of the composer is still over it.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setDragOver(false);
            },
            onDragOver: (event: DragEvent) => {
                if (!isComposerDrag(event)) return;
                /**
                 * The pane underneath would otherwise read an Editor tab drag as a move into this pane.
                 */
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'copy';
                setDragOver(true);
            },
            onDrop: (event: DragEvent) => {
                setDragOver(false);
                if (!isComposerDrag(event)) return;
                event.preventDefault();
                event.stopPropagation();
                const files = [...event.dataTransfer.files];
                const images = isImageInputEnabled ? agentChatImageFiles(event.dataTransfer) : [];
                attach(images);
                const attached = new Set(images);
                insertPaths(
                    event,
                    files.filter((file) => !attached.has(file)),
                );
            },
        },
        onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
            const { selectionEnd, selectionStart, value } = event.currentTarget;
            const warning = agentChatPasteTruncationWarning(
                {
                    currentLength: value.length,
                    pastedLength: event.clipboardData.getData('text/plain').length,
                    selectedLength: selectionEnd - selectionStart,
                },
                MAX_AGENT_CHAT_MESSAGE_LENGTH,
            );
            if (warning) pushToast('warning', warning);
            const files = agentChatImageFiles(event.clipboardData);
            if (files.length === 0) return;
            // Text copied alongside an image (an app that offers both) still pastes as text, and then says nothing.
            const hasText = Boolean(event.clipboardData.getData('text/plain'));
            if (!isImageInputEnabled) {
                if (!hasText) pushToast('info', agentChatImagesUnsupportedMessage(providerName));
                return;
            }
            if (!hasText) event.preventDefault();
            attach(files);
        },
    };
}

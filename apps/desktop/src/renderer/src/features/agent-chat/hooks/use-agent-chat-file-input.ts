import type { ClipboardEvent, DragEvent } from 'react';
import { useState } from 'react';

import { hasTerminalDraggedPath, PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import { pushToast } from '../../../stores/toasts';
import { EDITOR_PATH_DRAG_TYPE } from '../../workbench/pane-drop-zone';
import {
    agentChatDroppedImagePlan,
    agentChatImageFiles,
    agentChatImagesUnsupportedMessage,
    agentChatInsertedImagePathMessage,
} from '../agent-chat-images';

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
 * Paste, drag-and-drop, and file picker handlers for the composer. Images go to `add` when the provider accepts them;
 * every other dropped or picked file, Files entry, Editor tab, or Project is cited by path through `didInsertPaths`, as
 * a drop into a Terminal is. A dropped or picked image whose format or size cannot be attached is cited by path too,
 * with an info toast saying so, because it has a path on disk to cite. `didInsertPaths` receives the drop (absent for a
 * pick) and the files it should cite, and returns whether it inserted anything. A pasted image the provider cannot take
 * has no path to cite, so it says why in an info toast instead of silently doing nothing. Pasted text goes to
 * `takeLongPaste` first, which keeps a long paste out of the input.
 */
export function useAgentChatFileInput({
    add,
    didInsertPaths,
    isImageInputEnabled,
    providerName,
    takeLongPaste,
}: {
    add: (files: readonly File[]) => Promise<void>;
    didInsertPaths: (event: DragEvent | undefined, files: readonly File[]) => boolean;
    isImageInputEnabled: boolean;
    /**
     * The provider catalog's display name, for the toast that says it takes no images.
     */
    providerName: string;
    /**
     * Returns whether it took the paste's text (`useAgentChatLongPaste`).
     */
    takeLongPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => boolean;
}) {
    const [isDragOver, setDragOver] = useState(false);
    const attach = (files: readonly File[]): void => {
        // eslint-disable-next-line no-void -- add reports unreadable or rejected images through toasts
        if (isImageInputEnabled && files.length > 0) void add(files);
    };
    /**
     * Splits files between image attachments and path references, the same way for a drop and a pick.
     */
    const route = (event: DragEvent | undefined, files: readonly File[]): void => {
        const plan = agentChatDroppedImagePlan(
            isImageInputEnabled ? agentChatImageFiles(files) : [],
        );
        attach(plan.attach);
        const attached = new Set(plan.attach);
        const didInsert = didInsertPaths(
            event,
            files.filter((file) => !attached.has(file)),
        );
        const message = agentChatInsertedImagePathMessage(
            plan.inserted.map((entry) => entry.rejection),
        );
        if (didInsert && message) pushToast('info', message);
    };
    return {
        isDragOver,
        pick: (files: readonly File[]) => route(undefined, files),
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
                route(event, [...event.dataTransfer.files]);
            },
        },
        onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
            takeLongPaste(event);
            const files = agentChatImageFiles(event.clipboardData.files);
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

import type { ClipboardEvent, DragEvent } from 'react';
import { useState } from 'react';

import { hasTerminalDraggedPath, PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import { EDITOR_PATH_DRAG_TYPE } from '../../workbench/pane-drop-zone';
import { agentChatImageFiles } from '../agent-chat-images';

/**
 * Whether a drag carries something the composer takes: files from another application, a Files entry, an Editor tab, or
 * a Project. Only `types` is readable before the drop.
 */
function isComposerDrag(event: DragEvent): boolean {
    const { types } = event.dataTransfer;
    return (
        hasTerminalDraggedPath(event) ||
        types.includes(EDITOR_PATH_DRAG_TYPE) ||
        types.includes(PROJECT_PATH_DRAG_TYPE)
    );
}

/**
 * Paste and drag-and-drop handlers for the composer. Images go to `add` when the provider accepts them; every other
 * dropped file, Files entry, Editor tab, or Project is cited by path through `insertPaths`, as a drop into a Terminal
 * is. `insertPaths` receives the drop and the files it should cite.
 */
export function useAgentChatFileInput(
    isImageInputEnabled: boolean,
    add: (files: readonly File[]) => Promise<void>,
    insertPaths: (event: DragEvent, files: readonly File[]) => void,
) {
    const [isDragOver, setDragOver] = useState(false);
    const attach = (files: readonly File[]): void => {
        // eslint-disable-next-line no-void -- add reports unreadable or rejected images through toasts
        if (isImageInputEnabled && files.length > 0) void add(files);
    };
    return {
        attach,
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
        onPaste: (event: ClipboardEvent) => {
            const files = agentChatImageFiles(event.clipboardData);
            if (!isImageInputEnabled || files.length === 0) return;
            // Text copied alongside an image (an app that offers both) still pastes as text.
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            attach(files);
        },
    };
}

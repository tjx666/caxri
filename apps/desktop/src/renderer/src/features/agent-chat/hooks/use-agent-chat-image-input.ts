import type { ClipboardEvent, DragEvent } from 'react';
import { useState } from 'react';

import { agentChatImageFiles } from '../agent-chat-images';

/**
 * Paste and drag-and-drop handlers that hand image files to `add`. Inert when the provider does not accept images, so a
 * dropped file or pasted screenshot falls through to the default behavior.
 */
export function useAgentChatImageInput(
    isEnabled: boolean,
    add: (files: readonly File[]) => Promise<void>,
) {
    const [isDragOver, setDragOver] = useState(false);
    const attach = (files: readonly File[]): void => {
        // eslint-disable-next-line no-void -- add reports unreadable or rejected images through toasts
        if (isEnabled && files.length > 0) void add(files);
    };
    return {
        attach,
        isDragOver,
        dropHandlers: {
            onDragLeave: () => setDragOver(false),
            onDragOver: (event: DragEvent) => {
                if (!isEnabled || !event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                setDragOver(true);
            },
            onDrop: (event: DragEvent) => {
                setDragOver(false);
                const files = agentChatImageFiles(event.dataTransfer);
                if (!isEnabled || files.length === 0) return;
                event.preventDefault();
                attach(files);
            },
        },
        onPaste: (event: ClipboardEvent) => {
            const files = agentChatImageFiles(event.clipboardData);
            if (!isEnabled || files.length === 0) return;
            // Text copied alongside an image (an app that offers both) still pastes as text.
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            attach(files);
        },
    };
}

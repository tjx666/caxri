import type { ClipboardEvent, DragEvent } from 'react';
import { useState } from 'react';

import type { AgentChatPathReference } from '@caxri/protocol';

import {
    hasTerminalDraggedPath,
    osFilePaths,
    PROJECT_PATH_DRAG_TYPE,
} from '../../../lib/file-drag';
import { useIsLocalOnlyAvailable } from '../../../stores/environment';
import { pushToast } from '../../../stores/toasts';
import { EDITOR_PATH_DRAG_TYPE } from '../../workbench/pane-drop-zone';
import { pickAgentChatPaths } from '../agent-chat-commands';
import {
    agentChatDroppedImagePlan,
    agentChatImageFiles,
    agentChatImagesUnsupportedMessage,
    agentChatInsertedImagePathMessage,
    agentChatPickedImageFile,
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
 * every other dropped or picked file, Files entry, Editor tab, or Project is cited by path through `didInsertPaths`
 * (`useAgentChatComposerInput` decides between a card and text). A dropped or picked image whose format or size cannot
 * be attached is cited by path too, with an info toast saying so, because it has a path on disk to cite.
 * `didInsertPaths` receives the drop (absent for a pick) and the files it should cite, and returns whether it inserted
 * anything. A pasted image the provider cannot take has no path to cite, so it says why in an info toast instead of
 * silently doing nothing. Pasted text goes to `takeLongPaste` first, which keeps a long paste out of the input. In a
 * local window `+` → Files and folders opens the native panel instead (`pickPaths`), whose folders and files are cited
 * through `didInsertPickedPaths` and whose images take the same route as dropped ones.
 */
export function useAgentChatFileInput({
    add,
    didInsertPaths,
    didInsertPickedPaths,
    isImageInputEnabled,
    providerName,
    takeLongPaste,
}: {
    add: (files: readonly File[]) => Promise<void>;
    didInsertPaths: (event: DragEvent | undefined, files: readonly File[]) => boolean;
    didInsertPickedPaths: (references: readonly AgentChatPathReference[]) => boolean;
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
    const isLocalOnlyAvailable = useIsLocalOnlyAvailable();
    const attach = (files: readonly File[]): void => {
        // eslint-disable-next-line no-void -- add reports unreadable or rejected images through toasts
        if (isImageInputEnabled && files.length > 0) void add(files);
    };
    /**
     * Splits `images` between attachments and path references, the same way for a drop and a pick: `didCite` inserts
     * the paths of everything that was not attached and returns whether it inserted anything.
     */
    const route = (
        images: readonly File[],
        didCite: (attached: ReadonlySet<File>) => boolean,
    ): void => {
        const plan = agentChatDroppedImagePlan(
            isImageInputEnabled ? agentChatImageFiles(images) : [],
        );
        attach(plan.attach);
        const didInsert = didCite(new Set(plan.attach));
        const message = agentChatInsertedImagePathMessage(
            plan.inserted.map((entry) => entry.rejection),
        );
        if (didInsert && message) pushToast('info', message);
    };
    const routeFiles = (event: DragEvent | undefined, files: readonly File[]): void =>
        route(files, (attached) =>
            didInsertPaths(
                event,
                files.filter((file) => !attached.has(file)),
            ),
        );
    return {
        isDragOver,
        pick: (files: readonly File[]) => routeFiles(undefined, files),
        /**
         * Opens the native panel for files and folders together, or `undefined` in an SSH Host window (or before the
         * window's environment is known), whose Agent cannot read this Mac's paths; there `+` keeps the file-only
         * picker (`pick`) for images, and any other file it picks, like one dropped from Finder, is refused with a
         * toast instead of cited (`isOsFileReferenceRefused`).
         */
        pickPaths: !isLocalOnlyAvailable
            ? undefined
            : async (): Promise<void> => {
                  const picked = await pickAgentChatPaths(isImageInputEnabled);
                  if (!picked || picked.length === 0) return;
                  const images = new Map(
                      picked.flatMap(({ image, path }) =>
                          image ? [[agentChatPickedImageFile(path, image), path] as const] : [],
                      ),
                  );
                  route(images.keys().toArray(), (attached) => {
                      const attachedPaths = new Set([...attached].map((file) => images.get(file)));
                      return didInsertPickedPaths(
                          picked.flatMap(({ isDirectory, path }) =>
                              attachedPaths.has(path)
                                  ? []
                                  : [{ path, isDirectory: isDirectory === true }],
                          ),
                      );
                  });
              },
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
                routeFiles(event, [...event.dataTransfer.files]);
            },
        },
        onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
            const pasted = [...event.clipboardData.files];
            /**
             * Files and folders copied in Finder paste as files on disk, which attach like a drop of them; the file
             * names Finder also puts on the clipboard as text are not pasted.
             */
            if (osFilePaths(pasted).length > 0) {
                event.preventDefault();
                routeFiles(undefined, pasted);
                return;
            }
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

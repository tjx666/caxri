import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';

import { externalDocumentDiskState, externalDocumentWatchPath } from './external-documents';

/**
 * Editors write a file in several steps (truncate, write, rename a temporary file over it), and each step raises its
 * own event. Settling this long after the last one reads the finished file once.
 */
const SETTLE_MS = 150;

interface DirectoryWatch {
    close(): void;
}

export interface ExternalDocumentWatcherOptions {
    /**
     * Tells the Workbench that another app changed this document.
     */
    emit(documentId: string): void;
    diskState?: typeof externalDocumentDiskState;
    pathOf?: typeof externalDocumentWatchPath;
    settleMs?: number;
    /**
     * Observes one folder; `filename` is the entry that changed, or `undefined` when the platform could not say.
     */
    watchDirectory?: (directory: string, onChange: (filename?: string) => void) => DirectoryWatch;
}

function watchDirectoryWithNode(
    directory: string,
    onChange: (filename?: string) => void,
): DirectoryWatch {
    // Not persistent: an open external tab must never keep Main alive past quit.
    const watcher = watch(directory, { persistent: false }, (_event, filename) =>
        onChange(filename ?? undefined),
    );
    // A folder that disappears ends its watch; the documents in it have nothing left to reload.
    watcher.on('error', () => watcher.close());
    return watcher;
}

/**
 * Watches the external documents the Workbench has open for changes made by other apps (issue caxri#1566).
 *
 * It watches each document's folder rather than the file: many editors save by renaming a new file over the old one,
 * which a watch on the old file would never see. An event only names a candidate; the document is reported only when
 * its size or modification time differs from what Main last read or wrote, so Caxri's own saves stay silent.
 */
export function createExternalDocumentWatcher(options: ExternalDocumentWatcherOptions) {
    const diskState = options.diskState ?? externalDocumentDiskState;
    const pathOf = options.pathOf ?? externalDocumentWatchPath;
    const settleMs = options.settleMs ?? SETTLE_MS;
    const watchDirectory = options.watchDirectory ?? watchDirectoryWithNode;
    /**
     * Watched document IDs by folder, then by file name.
     */
    const folders = new Map<string, { names: Map<string, string>; watch: DirectoryWatch }>();
    const timers = new Map<string, NodeJS.Timeout>();

    function settle(documentId: string): void {
        clearTimeout(timers.get(documentId));
        timers.set(
            documentId,
            setTimeout(() => {
                timers.delete(documentId);
                // eslint-disable-next-line no-void -- `check` never rejects
                void check(documentId);
            }, settleMs),
        );
    }

    async function check(documentId: string): Promise<void> {
        const path = pathOf(documentId);
        if (!path || folders.get(dirname(path))?.names.get(basename(path)) !== documentId) return;
        let state: Awaited<ReturnType<typeof diskState>>;
        try {
            state = await diskState(documentId);
        } catch {
            return;
        }
        if (state === 'busy') settle(documentId);
        else if (state === 'changed') options.emit(documentId);
    }

    function stopFolder(folder: string): void {
        folders.get(folder)?.watch.close();
        folders.delete(folder);
    }

    return {
        /**
         * Replaces the watched set. Folders no document needs any more stop being watched.
         */
        setWatched(documentIds: readonly string[]): void {
            const wanted = new Map<string, Map<string, string>>();
            for (const documentId of documentIds) {
                const path = pathOf(documentId);
                if (!path) continue;
                const names = wanted.get(dirname(path)) ?? new Map<string, string>();
                names.set(basename(path), documentId);
                wanted.set(dirname(path), names);
            }
            for (const folder of folders.keys()) if (!wanted.has(folder)) stopFolder(folder);
            for (const [folder, names] of wanted) {
                const existing = folders.get(folder);
                if (existing) {
                    existing.names = names;
                    continue;
                }
                try {
                    const entry = {
                        names,
                        watch: watchDirectory(folder, (filename) => {
                            const current = folders.get(folder);
                            if (!current) return;
                            if (filename === undefined)
                                for (const documentId of current.names.values()) settle(documentId);
                            else {
                                const documentId = current.names.get(basename(filename));
                                if (documentId) settle(documentId);
                            }
                        }),
                    };
                    folders.set(folder, entry);
                } catch {
                    // An unwatchable folder (removed, or not readable) leaves its documents without change notices.
                }
            }
            const watched = new Set(documentIds);
            for (const [documentId, timer] of timers)
                if (!watched.has(documentId)) {
                    clearTimeout(timer);
                    timers.delete(documentId);
                }
        },
        dispose(): void {
            for (const folder of folders.keys()) stopFolder(folder);
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}

export type ExternalDocumentWatcher = ReturnType<typeof createExternalDocumentWatcher>;

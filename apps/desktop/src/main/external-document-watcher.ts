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
    watchDirectory?: (
        directory: string,
        onChange: (filename?: string) => void,
        onError: () => void,
    ) => DirectoryWatch;
}

/**
 * How long to wait before each new attempt to watch a folder whose watch failed or ended. A folder removed and created
 * again (a branch switch, a tool regenerating its output folder) usually comes back within seconds; after the last
 * attempt the folder stays unwatched until the Workbench's open set next names it.
 */
const REWATCH_DELAYS_MS = [1_000, 5_000, 30_000] as const;

/**
 * A folder that disappears ends its watch and reports `onError`; the watcher then retries it (`REWATCH_DELAYS_MS`).
 */
function watchDirectoryWithNode(
    directory: string,
    onChange: (filename?: string) => void,
    onError: () => void,
): DirectoryWatch {
    // Not persistent: an open external tab must never keep Main alive past quit.
    const watcher = watch(directory, { persistent: false }, (_event, filename) =>
        onChange(filename ?? undefined),
    );
    watcher.on('error', () => {
        watcher.close();
        onError();
    });
    return watcher;
}

/**
 * Watches the external documents the Workbench has open for changes made by other apps (issue caxri#1566).
 *
 * It watches each document's folder rather than the file: many editors save by renaming a new file over the old one,
 * which a watch on the old file would never see. An event only names a candidate; the document is reported only when
 * its size or modification time differs from what Main last read or wrote, so Caxri's own saves stay silent.
 *
 * The wanted documents are kept apart from the live watches because the Workbench re-sends its set only when the open
 * documents change, never when a watch dies. A folder whose watch ends or cannot start (removed, not readable yet) is
 * retried on a bounded backoff while some open document still needs it; a retry that succeeds re-checks the folder's
 * documents so a change made while it was unwatched is still reported.
 */
export function createExternalDocumentWatcher(options: ExternalDocumentWatcherOptions) {
    const diskState = options.diskState ?? externalDocumentDiskState;
    const pathOf = options.pathOf ?? externalDocumentWatchPath;
    const settleMs = options.settleMs ?? SETTLE_MS;
    const watchDirectory = options.watchDirectory ?? watchDirectoryWithNode;
    /**
     * The open document IDs by folder, then by file name, as of the last `setWatched`.
     */
    let wanted = new Map<string, Map<string, string>>();
    /**
     * The live watch of each folder in `wanted`; a folder whose watch failed is absent until a retry succeeds.
     */
    const folders = new Map<string, DirectoryWatch>();
    const retries = new Map<string, NodeJS.Timeout>();
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
        if (!path || wanted.get(dirname(path))?.get(basename(path)) !== documentId) return;
        let state: Awaited<ReturnType<typeof diskState>>;
        try {
            state = await diskState(documentId);
        } catch {
            return;
        }
        if (state === 'busy') settle(documentId);
        else if (state === 'changed') options.emit(documentId);
    }

    function settleFolder(folder: string): void {
        const documentIds = wanted.get(folder)?.values() ?? [];
        for (const documentId of documentIds) settle(documentId);
    }

    function cancelRetry(folder: string): void {
        clearTimeout(retries.get(folder));
        retries.delete(folder);
    }

    function stopFolder(folder: string): void {
        cancelRetry(folder);
        folders.get(folder)?.close();
        folders.delete(folder);
    }

    /**
     * Schedules attempt `attempt` (0-based) at watching `folder` again, unless the retries are spent.
     */
    function scheduleRetry(folder: string, attempt: number): void {
        cancelRetry(folder);
        if (attempt >= REWATCH_DELAYS_MS.length || !wanted.has(folder)) return;
        const delay = REWATCH_DELAYS_MS[attempt];
        retries.set(
            folder,
            setTimeout(() => {
                retries.delete(folder);
                if (!wanted.has(folder) || folders.has(folder)) return;
                watchFolder(folder, attempt + 1);
                if (folders.has(folder)) settleFolder(folder);
            }, delay),
        );
    }

    /**
     * Starts watching `folder`. `attempt` counts the retries already spent on it since its last working watch; a watch
     * that later ends starts a fresh retry budget.
     */
    function watchFolder(folder: string, attempt: number): void {
        let current: DirectoryWatch | undefined;
        try {
            current = watchDirectory(
                folder,
                (filename) => {
                    if (folders.get(folder) !== current) return;
                    if (filename === undefined) settleFolder(folder);
                    else {
                        const documentId = wanted.get(folder)?.get(basename(filename));
                        if (documentId) settle(documentId);
                    }
                },
                () => {
                    if (folders.get(folder) !== current) return;
                    folders.delete(folder);
                    scheduleRetry(folder, 0);
                },
            );
        } catch {
            // An unwatchable folder (removed, or not readable yet) is retried while its documents stay open.
            scheduleRetry(folder, attempt);
            return;
        }
        folders.set(folder, current);
    }

    return {
        /**
         * Replaces the watched set. Folders no document needs any more stop being watched and stop retrying; a wanted
         * folder without a live watch is tried again now.
         */
        setWatched(documentIds: readonly string[]): void {
            const next = new Map<string, Map<string, string>>();
            for (const documentId of documentIds) {
                const path = pathOf(documentId);
                if (!path) continue;
                const names = next.get(dirname(path)) ?? new Map<string, string>();
                names.set(basename(path), documentId);
                next.set(dirname(path), names);
            }
            wanted = next;
            for (const folder of [...folders.keys(), ...retries.keys()])
                if (!wanted.has(folder)) stopFolder(folder);
            for (const folder of wanted.keys())
                if (!folders.has(folder)) {
                    cancelRetry(folder);
                    watchFolder(folder, 0);
                }
            const watched = new Set(documentIds);
            for (const [documentId, timer] of timers)
                if (!watched.has(documentId)) {
                    clearTimeout(timer);
                    timers.delete(documentId);
                }
        },
        dispose(): void {
            wanted = new Map();
            for (const folder of [...folders.keys(), ...retries.keys()]) stopFolder(folder);
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}

export type ExternalDocumentWatcher = ReturnType<typeof createExternalDocumentWatcher>;

import { isUntitledEditorTabPath, virtualEditorTabScheme } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';

/**
 * Entries kept per window. Reopening is a "the thing I just closed" gesture, so a short history is enough. Entries hold
 * a Session id and a path; only an external document also keeps its last read copy, because closing evicts the only
 * cached copy it had.
 */
const CLOSED_ITEMS_LIMIT = 30;

/**
 * A closed editor tab, remembered with where it sat so it can return in place.
 */
export interface ClosedTabItem {
    kind: 'tab';
    sessionId: string;
    /**
     * Pane the tab was closed from. When that pane no longer exists the tab reopens in the active pane.
     */
    paneId: string;
    /**
     * Position within the pane's tab list at close time.
     */
    index: number;
    path: string;
    /**
     * Content of an external document, which lives only in the Renderer cache and is evicted by the close. Project
     * files re-read from disk and never carry one.
     */
    document?: EditorDocument;
}

/**
 * An archived Session. Closing a Session means archiving it: deleting is irreversible and never offered for reopening.
 */
export interface ClosedSessionItem {
    kind: 'session';
    sessionId: string;
}

export type ClosedItem = ClosedTabItem | ClosedSessionItem;

/**
 * Whether a closed tab is worth remembering. Terminals are excluded by the caller (closing one kills its PTY); this
 * covers the file-like tabs that cannot be rebuilt from their path.
 */
export function isRecordableTabPath(path: string): boolean {
    // An untitled buffer's content is discarded with its tab, and a side chat is a live Agent conversation owned
    // elsewhere: neither can be rebuilt from its path.
    return !isUntitledEditorTabPath(path) && virtualEditorTabScheme(path) !== 'agentSideChat';
}

function isSameItem(a: ClosedItem, b: ClosedItem): boolean {
    if (a.kind === 'session') return b.kind === 'session' && a.sessionId === b.sessionId;
    return b.kind === 'tab' && a.sessionId === b.sessionId && a.path === b.path;
}

/**
 * A most-recent-first history of closed editor tabs and Sessions. Renderer memory only: it is not persisted and nothing
 * outside the window reads it.
 */
export interface ClosedItemStack {
    /**
     * Records items closed together. The last item of `items` becomes the newest entry, so repeated reopens walk back
     * through a bulk close from its last tab to its first. An older entry for the same tab or Session is replaced
     * rather than duplicated, the way VS Code treats a re-closed editor.
     */
    push(items: readonly ClosedItem[]): void;
    /**
     * Drops every entry that belongs to the given Sessions (deleted Sessions can never be reopened).
     */
    forgetSessions(sessionIds: readonly string[]): void;
    /**
     * Takes entries from the newest end until `didReopen` reports one reopened, discarding the ones it rejects (a
     * deleted Session, a file that no longer opens). Resolves to the reopened item, or `undefined` when nothing could
     * be.
     */
    reopenNext(didReopen: (item: ClosedItem) => Promise<boolean>): Promise<ClosedItem | undefined>;
    snapshot(): readonly ClosedItem[];
    clear(): void;
}

export function createClosedItemStack(limit = CLOSED_ITEMS_LIMIT): ClosedItemStack {
    /**
     * Newest first.
     */
    let items: ClosedItem[] = [];
    /**
     * One reopen at a time: a held key must not interleave two walks over the same history.
     */
    let walking: Promise<ClosedItem | undefined> | undefined;

    async function walk(didReopen: (item: ClosedItem) => Promise<boolean>) {
        for (;;) {
            const next = items.shift();
            if (!next) return;
            // Intentionally sequential: each rejected entry must be settled before the next is tried.
            // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
            if (await didReopen(next)) return next;
        }
    }

    return {
        push(added) {
            const fresh = added.toReversed();
            items = [
                ...fresh,
                ...items.filter((existing) => fresh.every((item) => !isSameItem(item, existing))),
            ].slice(0, limit);
        },
        forgetSessions(sessionIds) {
            const gone = new Set(sessionIds);
            items = items.filter((item) => !gone.has(item.sessionId));
        },
        reopenNext(didReopen) {
            if (walking) return walking;
            const run = async () => {
                try {
                    return await walk(didReopen);
                } finally {
                    walking = undefined;
                }
            };
            walking = run();
            return walking;
        },
        snapshot: () => items,
        clear() {
            items = [];
        },
    };
}

/**
 * The window's closed-item history. Closing code pushes to it; `reopenClosedItem` is its only consumer.
 */
export const closedItems = createClosedItemStack();

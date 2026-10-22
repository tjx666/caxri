import type { DeviceStoreBackend, EnvironmentState } from '@caxri/protocol';
import { createDeviceStore, isVirtualEditorTabPath } from '@caxri/protocol';
import type { EditorDocument, SessionDocuments } from '@desktop-shared/editor-state';
import { z } from 'zod';

import { indexedDatabaseDeviceStoreBackend } from '../../lib/indexed-database-device-store';
import { environmentStorageScope, useEnvironmentStore } from '../../stores/environment';
import { getBootstrap } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { announceDiscardedBuffers } from './discarded-buffers';

/**
 * Hot exit for Editor buffers, as VS Code backs up dirty working copies: each unsaved buffer is copied to this device's
 * IndexedDB about a second after the user stops typing, so a crash, a reload, or a quit that never asked (the Renderer
 * died) loses at most that second. The backup is dropped once the buffer is saved, reverted, closed without saving, or
 * its Session is deleted, and after the user chose Don't Save on quit.
 *
 * A backup is restored when a later launch reads the same document from disk. The file is unchanged since the backup's
 * base (same modification time and size): the buffer comes back unsaved over it. The file changed while Caxri was
 * closed: disk wins as it does for a live buffer (ADR 0013), and "Restore My Changes" offers the backup back.
 *
 * Backups never leave this device. They live in the Renderer profile, not Server Core, because an SSH Host or a phone
 * may be the Server: the device that typed the text keeps it.
 */

/**
 * Bumped when the backup shape changes; a backup from another version is dropped rather than migrated.
 */
const EDITOR_BACKUP_VERSION = 1;
const EDITOR_BACKUP_WRITE_DELAY_MS = 1_000;
/**
 * Unsaved buffers kept per environment; the least recently backed up go first.
 */
const MAX_EDITOR_BACKUPS = 50;
const DATABASE_NAME = 'caxri-editor-backups';

const editorBackupSchema = z.strictObject({
    sessionId: z.string().min(1),
    workbenchProjectId: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    /**
     * The disk state the buffer was edited from, which decides between restoring it and announcing a conflict.
     */
    mtimeMs: z.number(),
    size: z.number(),
});

export type EditorBackup = z.infer<typeof editorBackupSchema>;

export function editorBackupName(viewScope: string, path: string): string {
    return JSON.stringify([viewScope, path]);
}

function isBackedUp(document: EditorDocument): boolean {
    return (
        document.dirty &&
        !document.readOnly &&
        !document.ephemeral &&
        !isVirtualEditorTabPath(document.path)
    );
}

/**
 * The Session and Workbench Root a session-view scope (`sessionViewScope`) belongs to. The bare Session scope is the
 * owner root, its own Project.
 */
function scopeOwner(
    viewScope: string,
    projectIdOf: (sessionId: string) => string | undefined,
): { sessionId: string; workbenchProjectId: string } | undefined {
    const separator = viewScope.indexOf('\0');
    const sessionId = separator === -1 ? viewScope : viewScope.slice(0, separator);
    const workbenchProjectId =
        separator === -1 ? projectIdOf(sessionId) : viewScope.slice(separator + 1);
    return sessionId && workbenchProjectId ? { sessionId, workbenchProjectId } : undefined;
}

export interface EditorBackupChanges {
    save: Array<{ name: string; backup: EditorBackup }>;
    remove: string[];
}

function scopedDocuments(
    documents: SessionDocuments,
): Array<{ viewScope: string; document: EditorDocument }> {
    return Object.entries(documents).flatMap(([viewScope, scoped]) =>
        Object.values(scoped).map((document) => ({ viewScope, document })),
    );
}

function documentAt(
    documents: SessionDocuments,
    viewScope: string,
    path: string,
): EditorDocument | undefined {
    const scoped = Object.hasOwn(documents, viewScope) ? documents[viewScope] : undefined;
    return scoped && Object.hasOwn(scoped, path) ? scoped[path] : undefined;
}

/**
 * What one session-view change means for the backups: every unsaved buffer that changed is saved again, and every
 * buffer that stopped being unsaved (saved, reverted, closed, renamed away, or its Session dropped) loses its backup.
 */
export function editorBackupChanges(
    previous: SessionDocuments,
    next: SessionDocuments,
    projectIdOf: (sessionId: string) => string | undefined,
): EditorBackupChanges {
    const save = scopedDocuments(next).flatMap(({ viewScope, document }) => {
        if (!isBackedUp(document) || documentAt(previous, viewScope, document.path) === document)
            return [];
        const owner = scopeOwner(viewScope, projectIdOf);
        if (!owner) return [];
        const backup: EditorBackup = {
            ...owner,
            path: document.path,
            content: document.content,
            mtimeMs: document.mtimeMs,
            size: document.size,
        };
        return [{ name: editorBackupName(viewScope, document.path), backup }];
    });
    const remove = scopedDocuments(previous)
        .filter(({ viewScope, document }) => {
            if (!isBackedUp(document)) return false;
            const current = documentAt(next, viewScope, document.path);
            return !current || !isBackedUp(current);
        })
        .map(({ viewScope, document }) => editorBackupName(viewScope, document.path));
    return { save, remove };
}

/**
 * What a backup from an earlier launch does once its document was read from disk again.
 */
export function editorBackupRestore(
    backup: EditorBackup,
    document: EditorDocument,
): 'conflict' | 'drop' | 'restore' {
    if (document.readOnly || document.content === backup.content) return 'drop';
    return document.mtimeMs === backup.mtimeMs && document.size === backup.size
        ? 'restore'
        : 'conflict';
}

export interface EditorBackupsOptions {
    backend: DeviceStoreBackend;
    scope: string;
    projectIdOf: (sessionId: string) => string | undefined;
    now?: () => number;
}

/**
 * Mirrors the session-view store's unsaved buffers into `backend` and restores what an earlier launch left there. The
 * store owns ordering, debouncing, and failure handling: every failure loses a backup, never an edit.
 */
export function createEditorBackups(options: EditorBackupsOptions) {
    const { backend, projectIdOf, scope } = options;
    const store = createDeviceStore({
        backend,
        now: options.now,
        retention: { isBounded: () => true, maxEntries: MAX_EDITOR_BACKUPS },
        version: EDITOR_BACKUP_VERSION,
        writeDelayMs: EDITOR_BACKUP_WRITE_DELAY_MS,
    });
    store.setScope(scope);
    /**
     * Backups an earlier launch left, waiting for their document to be read from disk again.
     */
    const restorable = new Map<string, EditorBackup>();

    function restoreOne(name: string, backup: EditorBackup, documents: SessionDocuments): void {
        const [viewScope] = JSON.parse(name) as [string, string];
        const document = documentAt(documents, viewScope, backup.path);
        // An unsaved document already holds newer typing from this launch; its own backup replaces this one.
        if (!document || document.dirty) return;
        restorable.delete(name);
        const outcome = editorBackupRestore(backup, document);
        if (outcome === 'restore') {
            useSessionViewStore
                .getState()
                .updateDocumentContent(
                    backup.sessionId,
                    backup.path,
                    backup.content,
                    backup.workbenchProjectId,
                );
            return;
        }
        store.remove(name);
        if (outcome === 'conflict')
            announceDiscardedBuffers(backup.sessionId, backup.workbenchProjectId, [backup]);
    }

    function restoreLoaded(documents: SessionDocuments): void {
        for (const [name, backup] of restorable) restoreOne(name, backup, documents);
    }

    function apply(previous: SessionDocuments, next: SessionDocuments): void {
        const changes = editorBackupChanges(previous, next, projectIdOf);
        for (const { name, backup } of changes.save) {
            restorable.delete(name);
            store.save(scope, name, backup);
        }
        for (const name of changes.remove) store.remove(name);
        if (restorable.size > 0) restoreLoaded(next);
    }

    /**
     * Reads every backup an earlier launch left, then follows the session-view store. Documents already read before the
     * backups loaded are restored at once.
     */
    async function start(): Promise<() => void> {
        try {
            const listed = await backend.list();
            for (const { name } of listed) {
                // eslint-disable-next-line no-await-in-loop -- a handful of small reads, once per launch
                const entry = await store.load(scope, name, editorBackupSchema);
                if (entry) restorable.set(name, entry.value);
                else store.remove(name);
            }
        } catch {
            // An unreadable database restores nothing; backing up this launch's buffers still works.
        }
        let previous: SessionDocuments = {};
        const follow = (documents: SessionDocuments): void => {
            const before = previous;
            previous = documents;
            apply(before, documents);
        };
        follow(useSessionViewStore.getState().documents);
        return useSessionViewStore.subscribe((state) => {
            if (state.documents !== previous) follow(state.documents);
        });
    }

    /**
     * Drops the backups of every unsaved buffer, for Don't Save on quit or window close. Backups not yet restored stay:
     * the prompt never named them.
     */
    async function discardAll(): Promise<void> {
        const documents = scopedDocuments(useSessionViewStore.getState().documents);
        for (const { viewScope, document } of documents)
            if (isBackedUp(document)) store.remove(editorBackupName(viewScope, document.path));
        await store.flush();
    }

    return { discardAll, flush: store.flush, start };
}

/**
 * This window's backups, held in an object so the subscription can replace them without reassigning a module binding.
 */
const current: { backups?: ReturnType<typeof createEditorBackups> } = {};

/**
 * Drops this window's backups of its unsaved buffers; a window that never started backups has none.
 */
export async function discardEditorBackups(): Promise<void> {
    await current.backups?.discardAll();
}

/**
 * Starts hot exit for this Workbench window once it knows its environment, which names the database
 * (`environmentStorageScope`). Writes still waiting are flushed when the window is hidden or unloaded.
 */
export function subscribeEditorBackups(): () => void {
    let stopFollowing: (() => void) | undefined;
    let isActive = true;
    const flush = (): void => {
        // eslint-disable-next-line no-void -- best effort while the page goes away
        void current.backups?.flush();
    };
    const onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') flush();
    };
    const begin = (environment: EnvironmentState): void => {
        const scope = environmentStorageScope(environment);
        const backups = createEditorBackups({
            backend: indexedDatabaseDeviceStoreBackend(
                scope === 'local' ? DATABASE_NAME : `${DATABASE_NAME}:${scope}`,
            ),
            projectIdOf: (sessionId) =>
                getBootstrap()?.sessions.find((session) => session.id === sessionId)?.projectId,
            scope,
        });
        current.backups = backups;
        // eslint-disable-next-line no-void -- `start` handles its own read failures
        void backups.start().then((stop) => {
            if (isActive) stopFollowing = stop;
            else stop();
        });
    };
    const environment = useEnvironmentStore.getState().state;
    const unsubscribeEnvironment = environment
        ? undefined
        : useEnvironmentStore.subscribe((state) => {
              if (current.backups || !state.state) return;
              begin(state.state);
          });
    if (environment) begin(environment);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
        isActive = false;
        unsubscribeEnvironment?.();
        stopFollowing?.();
        flush();
        current.backups = undefined;
        window.removeEventListener('pagehide', flush);
        document.removeEventListener('visibilitychange', onVisibilityChange);
    };
}

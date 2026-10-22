import type { BootstrapState, DeviceStoreBackend, SessionState } from '@caxri/protocol';
import { encodeDeviceStoreEntry } from '@caxri/protocol';
import type { EditorDocument, SessionDocuments } from '@desktop-shared/editor-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn(), onEvent: vi.fn() } }));
vi.mock('../../../stores/toasts', () => ({ pushToast: vi.fn() }));

import { getSessionDocuments, useSessionViewStore } from '../../../stores/session-view';
import { pushToast } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import { clearDiscardedBuffers, discardedChangesUnavailableReason } from '../discarded-buffers';
import type { EditorBackup } from '../editor-backups';
import {
    createEditorBackups,
    editorBackupChanges,
    editorBackupName,
    editorBackupRestore,
} from '../editor-backups';

const path = '/project/first.ts';
const projectIdOf = (sessionId: string) => (sessionId === 'session-1' ? 'project-1' : undefined);

const document = (overrides: Partial<EditorDocument> = {}): EditorDocument => ({
    path,
    content: 'disk content',
    dirty: false,
    mtimeMs: 2,
    size: 12,
    ...overrides,
});

const backup = (overrides: Partial<EditorBackup> = {}): EditorBackup => ({
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
    path,
    content: 'my edit',
    mtimeMs: 2,
    size: 12,
    ...overrides,
});

const memoryBackend = () => {
    const entries = new Map<string, string>();
    const backend: DeviceStoreBackend = {
        clear: () => Promise.resolve(entries.clear()),
        list: () =>
            Promise.resolve(
                entries
                    .keys()
                    .map((name, index) => ({ name, modifiedAt: index }))
                    .toArray(),
            ),
        read: (name) => Promise.resolve(entries.get(name) ?? null),
        remove: (name) => {
            entries.delete(name);
            return Promise.resolve();
        },
        write: (name, text) => {
            entries.set(name, text);
            return Promise.resolve();
        },
    };
    return { backend, entries };
};

describe('editor backup changes', () => {
    it('backs up each changed unsaved buffer and drops one that stopped being unsaved', () => {
        const dirty = document({ content: 'typed', dirty: true });
        const first = editorBackupChanges({}, { 'session-1': { [path]: dirty } }, projectIdOf);
        expect(first.save).toEqual([
            {
                name: editorBackupName('session-1', path),
                backup: backup({ content: 'typed' }),
            },
        ]);
        expect(
            editorBackupChanges(
                { 'session-1': { [path]: dirty } },
                { 'session-1': { [path]: dirty } },
                projectIdOf,
            ),
        ).toEqual({ save: [], remove: [] });
        const afterSave: SessionDocuments = { 'session-1': { [path]: document({ mtimeMs: 3 }) } };
        for (const next of [afterSave, {}])
            expect(
                editorBackupChanges({ 'session-1': { [path]: dirty } }, next, projectIdOf).remove,
            ).toEqual([editorBackupName('session-1', path)]);
    });

    it('skips buffers that never reach disk and names an alternate root by its Project', () => {
        const changes = editorBackupChanges(
            {},
            {
                'session-1': {
                    a: document({ path: 'a', dirty: true, ephemeral: true }),
                    b: document({ path: 'b', dirty: true, readOnly: true }),
                },
                'session-1\0project-2': { [path]: document({ dirty: true }) },
            },
            projectIdOf,
        );
        expect(changes.save.map(({ backup: saved }) => saved.workbenchProjectId)).toEqual([
            'project-2',
        ]);
    });

    it('restores over the unchanged base, and reports a conflict when the file moved on', () => {
        expect(editorBackupRestore(backup(), document())).toBe('restore');
        expect(editorBackupRestore(backup(), document({ mtimeMs: 9 }))).toBe('conflict');
        expect(editorBackupRestore(backup(), document({ content: 'my edit', mtimeMs: 9 }))).toBe(
            'drop',
        );
        expect(editorBackupRestore(backup(), document({ readOnly: true }))).toBe('drop');
    });
});

describe('editor backups across a restart', () => {
    beforeEach(() => {
        clearDiscardedBuffers();
        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [
                    { id: 'session-1', projectId: 'project-1', workbenchProjectId: 'project-1' },
                ],
                sessionStates: [
                    { sessionId: 'session-1', workbenchProjectId: 'project-1' } as SessionState,
                ],
            } as unknown as BootstrapState,
        });
    });
    afterEach(() => {
        vi.mocked(pushToast).mockClear();
    });

    const launch = (entries: Map<string, string>, backend: DeviceStoreBackend) => {
        entries.set(
            editorBackupName('session-1', path),
            encodeDeviceStoreEntry(1, 'local', 1, backup()),
        );
        return createEditorBackups({ backend, projectIdOf, scope: 'local' });
    };

    const readFromDisk = (overrides: Partial<EditorDocument> = {}) =>
        useSessionViewStore.getState().cacheDocument('session-1', document(overrides), 'project-1');

    it('brings an unsaved buffer back once its unchanged file is read again', async () => {
        const { backend, entries } = memoryBackend();
        const stop = await launch(entries, backend).start();
        readFromDisk();
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: 'my edit',
            dirty: true,
        });
        expect(pushToast).not.toHaveBeenCalled();
        stop();
    });

    it('lets disk win and offers the backup back when the file changed while closed', async () => {
        const { backend, entries } = memoryBackend();
        readFromDisk({ content: 'newer on disk', mtimeMs: 5 });
        const backups = launch(entries, backend);
        const stop = await backups.start();
        await backups.flush();
        expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
            content: 'newer on disk',
            dirty: false,
        });
        expect(pushToast).toHaveBeenCalledOnce();
        expect(
            discardedChangesUnavailableReason({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                paths: [path],
            }),
        ).toBeUndefined();
        // Kept until the restored buffer replaces it, so a restart before restoring loses nothing.
        expect(entries.size).toBe(1);
        stop();
    });

    it('keeps a backup whose read failed at launch, so the next launch can restore it', async () => {
        const { backend, entries } = memoryBackend();
        const backups = launch(entries, {
            ...backend,
            read: () => Promise.reject(new Error('io')),
        });
        const stop = await backups.start();
        await backups.flush();
        expect(entries.size).toBe(1);
        stop();
    });

    it("drops the backups of this launch's buffers on Don't Save", async () => {
        const { backend, entries } = memoryBackend();
        const backups = launch(entries, backend);
        const stop = await backups.start();
        readFromDisk();
        await backups.flush();
        expect(entries.size).toBe(1);
        await backups.discardAll();
        expect(entries.size).toBe(0);
        stop();
    });
});

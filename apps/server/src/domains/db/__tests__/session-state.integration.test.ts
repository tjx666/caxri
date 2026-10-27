import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPaneTerminalIds } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabaseConnection as CaxriDatabase } from '../index';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

describe('Session state persistence', () => {
    it('round-trips editorRemapOperationId together with the pane layout', async () => {
        const directory = await temporaryDirectory('caxri-db-remap-operation-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, title: 'Shell' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        database.sessions.insertInitialState(session.id, terminal.id);

        database.sessions.updateState({
            ...database.sessions.getState(session.id),
            editorRemapOperationId: 'operation-1',
        });

        const restored = database.sessions.getState(session.id);
        expect(restored.editorRemapOperationId).toBe('operation-1');
        expect(listPaneTerminalIds(restored.paneLayout)).toEqual([terminal.id]);
        database.close();
    });

    it('round-trips view state independently for each Session', async () => {
        const directory = await temporaryDirectory('caxri-db-extension-tree-state-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const first = database.sessions.insert({ projectId: project.id, title: 'First' });
        const second = database.sessions.insert({ projectId: project.id, title: 'Second' });
        database.sessions.insertInitialState(first.id);
        database.sessions.insertInitialState(second.id);

        database.sessions.updateState({
            ...database.sessions.getState(first.id),
            extensionTreeViewStates: {
                'publisher.fixture.tree': {
                    expandedItemIds: ['repository'],
                    initializedItemIds: ['repository'],
                    focusedItemId: 'repository',
                },
            },
            sourceControlViewStates: {
                'caxri.git.sourceControl': {
                    expandedDirectories: {},
                    expandedGroups: { changes: false },
                    expandedProviders: { repository: true },
                    modeId: 'changes',
                },
            },
        });

        expect(database.sessions.getState(first.id).extensionTreeViewStates).toEqual({
            'publisher.fixture.tree': {
                expandedItemIds: ['repository'],
                initializedItemIds: ['repository'],
                focusedItemId: 'repository',
            },
        });
        expect(database.sessions.getState(second.id).extensionTreeViewStates).toBeUndefined();
        expect(database.sessions.getState(first.id).sourceControlViewStates).toEqual({
            'caxri.git.sourceControl': {
                expandedDirectories: {},
                expandedGroups: { changes: false },
                expandedProviders: { repository: true },
                modeId: 'changes',
            },
        });
        expect(database.sessions.getState(second.id).sourceControlViewStates).toBeUndefined();
        database.close();
    });

    it('rejects a layout written from a revision another writer has already superseded', async () => {
        const directory = await temporaryDirectory('caxri-db-session-state-revision-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, title: 'Shell' });
        database.sessions.insertInitialState(session.id);

        // Both clients read the same state, as two windows arranging the same Session would.
        const read = database.sessions.getState(session.id);
        database.sessions.updateState({ ...read, editorRemapOperationId: 'winner' });

        expect(() =>
            database.sessions.updateState({ ...read, editorRemapOperationId: 'loser' }),
        ).toThrow(
            expect.objectContaining({
                code: 'CONFLICT',
                // The current revision travels with the rejection so the loser can rebase without another read.
                details: { currentRevision: read.revision + 1, writtenRevision: read.revision },
            }),
        );
        expect(database.sessions.getState(session.id).editorRemapOperationId).toBe('winner');

        // Re-deriving the same change against the state that won is accepted and keeps nothing of the losing read.
        const rebased = database.sessions.getState(session.id);
        expect(rebased.revision).toBe(read.revision + 1);
        database.sessions.updateState({ ...rebased, editorRemapOperationId: 'loser' });
        expect(database.sessions.getState(session.id).editorRemapOperationId).toBe('loser');
        database.close();
    });

    it('advances the revision only for a write that changes the stored row', async () => {
        const directory = await temporaryDirectory('caxri-db-session-state-no-op-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, title: 'Shell' });
        database.sessions.insertInitialState(session.id);

        const stored = database.sessions.getState(session.id);
        // Re-persisting an identical arrangement is an ordinary Renderer no-op; invalidating a concurrent writer's
        // perfectly current revision for it would manufacture conflicts nobody can act on.
        database.sessions.updateState(stored);
        expect(database.sessions.getState(session.id).revision).toBe(stored.revision);
        database.sessions.updateState(stored);
        expect(database.sessions.getState(session.id).revision).toBe(stored.revision);
        database.close();
    });

    it('bumps the revision when the Server itself rewrites every Root arrangement', async () => {
        const directory = await temporaryDirectory('caxri-db-session-state-server-edit-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, title: 'Shell' });
        database.sessions.insertInitialState(session.id);
        const read = database.sessions.getState(session.id);

        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        database.sessions.addTerminalToAllRootStates(session.id, terminal.id);

        // A Server-owned edit changes what the client last read just as a rival client write would, so a Renderer
        // still holding the pre-edit token must not be able to write the new Terminal back out of the layout.
        expect(() => database.sessions.updateState(read)).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        expect(listPaneTerminalIds(database.sessions.getState(session.id).paneLayout)).toEqual([
            terminal.id,
        ]);
        database.close();
    });

    it('hands a repaired Session state the revision its repair stored', async () => {
        const directory = await temporaryDirectory('caxri-db-session-state-repair-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, title: 'Shell' });
        database.sessions.insertInitialState(session.id);
        database.database
            .prepare('update session_views set roots_json = ? where session_id = ?')
            .run('not json', session.id);

        // Reading an unparsable row repairs it in place. Returning the revision it read rather than the one the
        // repair stored would make the client's very first ordinary write look stale.
        const repaired = database.sessions.getState(session.id);
        expect(() =>
            database.sessions.updateState({ ...repaired, editorRemapOperationId: 'after-repair' }),
        ).not.toThrow();
        expect(database.sessions.getState(session.id).editorRemapOperationId).toBe('after-repair');
        database.close();
    });

    it('loads all Session states with one Terminal ownership query', async () => {
        const directory = await temporaryDirectory('caxri-db-session-states-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const first = database.sessions.insert({ projectId: project.id, title: 'First' });
        const second = database.sessions.insert({ projectId: project.id, title: 'Second' });
        const insertTerminal = (sessionId: string) =>
            database.terminals.insert({
                sessionId,
                kind: 'shell',
                cwd: directory,
                title: 'Shell',
            });
        database.sessions.insertInitialState(first.id, insertTerminal(first.id).id);
        database.sessions.insertInitialState(second.id, insertTerminal(second.id).id);

        const prepare = vi.spyOn(database.database, 'prepare');

        expect(database.sessions.listStates().map((state) => state.sessionId)).toEqual(
            database.sessions.list().map((session) => session.id),
        );
        expect(
            prepare.mock.calls.filter(([statement]) => statement.includes('from "terminals"')),
        ).toHaveLength(1);
        database.close();
    });
});

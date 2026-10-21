import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabaseConnection as CaxriDatabase } from '../index';
import type {
    SessionStateRevisionAdvance,
    SessionStateStaleWrite,
} from '../models/session-state-revisions';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function observedDatabase(prefix: string, databasePath?: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    const advances: SessionStateRevisionAdvance[] = [];
    const staleWrites: SessionStateStaleWrite[] = [];
    const database = new CaxriDatabase(databasePath ?? join(directory, 'state.db'), {
        onSessionStateRevisionAdvanced: (advance) => advances.push(advance),
        onSessionStateStaleWrite: (staleWrite) => staleWrites.push(staleWrite),
    });
    return { advances, database, directory, staleWrites };
}

function shellTerminal(database: CaxriDatabase, sessionId: string, cwd: string) {
    return database.terminals.insert({ sessionId, kind: 'shell', cwd, title: 'Shell' });
}

/**
 * A rejected `session.updateState` silently reverts the user's layout change, and the rejection alone cannot say what
 * moved the row. These pin the evidence a stale write carries: who advanced the revision last, and how long ago.
 */
describe('Session state revision bookkeeping', () => {
    it('names the Server-owned write that moved the row under a stale client write', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { advances, database, directory, staleWrites } = await observedDatabase(
            'caxri-db-revision-terminal-created-',
        );
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        database.sessions.insertInitialState(session.id);
        const read = database.sessions.getState(session.id);

        const terminal = shellTerminal(database, session.id, directory);
        database.sessions.addTerminalToAllRootStates(session.id, terminal.id);
        vi.advanceTimersByTime(250);

        expect(() =>
            database.sessions.updateState(
                { ...read, editorRemapOperationId: 'late' },
                'clientWrite',
            ),
        ).toThrow(
            expect.objectContaining({
                code: 'CONFLICT',
                details: { currentRevision: read.revision + 1, writtenRevision: read.revision },
            }),
        );
        expect(advances).toEqual([
            { sessionId: session.id, reason: 'terminalCreated', revision: read.revision + 1 },
        ]);
        expect(staleWrites).toEqual([
            {
                sessionId: session.id,
                currentRevision: read.revision + 1,
                writtenRevision: read.revision,
                lastWriteReason: 'terminalCreated',
                lastWriteRevision: read.revision + 1,
                lastWriteAgeMs: 250,
            },
        ]);
        database.close();
    });

    it('remembers a client write as the last writer without reporting each one', async () => {
        const { advances, database, directory, staleWrites } = await observedDatabase(
            'caxri-db-revision-client-write-',
        );
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        database.sessions.insertInitialState(session.id);
        const read = database.sessions.getState(session.id);

        database.sessions.updateState({ ...read, editorRemapOperationId: 'winner' }, 'clientWrite');
        expect(() =>
            database.sessions.updateState(
                { ...read, editorRemapOperationId: 'loser' },
                'clientWrite',
            ),
        ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));

        // Client writes are the hot path: one per layout change, so only the ledger keeps them.
        expect(advances).toEqual([]);
        expect(staleWrites).toEqual([
            expect.objectContaining({
                lastWriteReason: 'clientWrite',
                lastWriteRevision: read.revision + 1,
            }),
        ]);
        database.close();
    });

    it('reports every Server-owned rewrite with its closed reason', async () => {
        const { advances, database, directory } = await observedDatabase(
            'caxri-db-revision-reasons-',
        );
        const project = database.projects.create(directory);
        const alternateRoot = join(directory, 'alternate');
        await mkdir(alternateRoot);
        const alternate = database.projects.create(alternateRoot);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        database.sessions.insertInitialState(session.id);
        const reasons = () => advances.map((advance) => advance.reason);

        // A Terminal the stored tabs do not show yet is repaired into them on the next read.
        const untracked = shellTerminal(database, session.id, directory);
        database.sessions.getState(session.id);
        expect(reasons()).toEqual(['terminalTabRepair']);

        database.terminals.remove(untracked.id);
        database.sessions.removeTerminalFromAllRootStates(
            session.id,
            untracked.id,
            'terminalClosed',
        );
        // Re-storing an identical state advances nothing, so it leaves no record either.
        database.sessions.updateState(database.sessions.getState(session.id));
        database.sessions.updateState({
            ...database.sessions.getState(session.id),
            editorRemapOperationId: 'service',
        });
        expect(reasons()).toEqual(['terminalTabRepair', 'terminalClosed', 'serviceWrite']);

        // Showing another Workbench Root stores its first snapshot; deleting that Root prunes it again.
        database.sessions.setWorkbenchProject(session.id, alternate.id);
        database.sessions.getState(session.id);
        database.sessions.resetWorkbenchProject(alternate.id);
        expect(reasons().slice(3)).toEqual(['rootFirstVisit', 'projectPruned']);

        database.database
            .prepare('update session_state set workbench_state_json = ? where session_id = ?')
            .run('not json', session.id);
        const repaired = database.sessions.getState(session.id);
        expect(advances.at(-1)).toEqual({
            sessionId: session.id,
            reason: 'unreadableRepair',
            revision: repaired.revision,
        });
        database.close();
    });

    it('reports a revision that moved before this Server Core lifetime as unrecorded', async () => {
        const first = await observedDatabase('caxri-db-revision-unrecorded-');
        const databasePath = join(first.directory, 'state.db');
        const project = first.database.projects.create(first.directory);
        const session = first.database.sessions.insert({
            projectId: project.id,
            displayTitle: 'Shell',
        });
        first.database.sessions.insertInitialState(session.id);
        const read = first.database.sessions.getState(session.id);
        first.database.sessions.updateState({ ...read, editorRemapOperationId: 'before-restart' });
        first.database.close();

        const restarted = await observedDatabase('caxri-db-revision-restarted-', databasePath);
        expect(() => restarted.database.sessions.updateState(read, 'clientWrite')).toThrow(
            expect.objectContaining({ code: 'CONFLICT' }),
        );
        expect(restarted.staleWrites).toEqual([
            {
                sessionId: session.id,
                currentRevision: read.revision + 1,
                writtenRevision: read.revision,
                lastWriteReason: 'unrecorded',
                lastWriteRevision: null,
                lastWriteAgeMs: null,
            },
        ]);
        restarted.database.close();
    });

    it('hands the reader the repaired revision so its next write is not rejected as stale', async () => {
        const { advances, database, directory, staleWrites } = await observedDatabase(
            'caxri-db-revision-repair-token-',
        );
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        database.sessions.insertInitialState(session.id);
        const before = database.sessions.getState(session.id);

        // The read repairs the missing tab and stores a newer revision than the one it parsed.
        const terminal = shellTerminal(database, session.id, directory);
        const repaired = database.sessions.getState(session.id);
        expect(advances.map((advance) => advance.reason)).toEqual(['terminalTabRepair']);
        expect(repaired.revision).toBe(before.revision + 1);

        // The pre-repair token is stale (the CONFLICT a repair can cause), while the returned one is current.
        expect(() =>
            database.sessions.updateState(
                { ...before, editorRemapOperationId: 'old' },
                'clientWrite',
            ),
        ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(staleWrites).toEqual([
            expect.objectContaining({
                lastWriteReason: 'terminalTabRepair',
                writtenRevision: before.revision,
                currentRevision: repaired.revision,
            }),
        ]);
        expect(() =>
            database.sessions.updateState(
                { ...repaired, editorRemapOperationId: 'fresh' },
                'clientWrite',
            ),
        ).not.toThrow();
        expect(terminal.id).toBeTruthy();
        database.close();
    });
});

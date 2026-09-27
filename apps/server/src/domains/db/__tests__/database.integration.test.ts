import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import type { DatabaseTransactionObservation } from '../database-connection';
import { CaxriDatabaseConnection as CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION } from '../migrations/manifest';

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

describe('CaxriDatabaseConnection', () => {
    it('observes transaction latency and contention without changing database behavior', () => {
        const observations: DatabaseTransactionObservation[] = [];
        const onTransaction = vi.fn((observation: DatabaseTransactionObservation) => {
            observations.push(observation);
        });
        const database = new CaxriDatabase(':memory:', { onTransaction });

        expect(database.transaction(() => 42)).toBe(42);
        for (const code of ['SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED_SHAREDCACHE']) {
            const contention = Object.assign(new Error('busy'), { code });
            expect(() =>
                database.transaction(() => {
                    throw contention;
                }),
            ).toThrow(contention);
        }
        expect(observations.map(({ outcome }) => outcome)).toEqual([
            'success',
            'contention',
            'contention',
        ]);
        expect(observations.every(({ durationMs }) => durationMs >= 0)).toBe(true);
        database.close();
    });

    it('creates the current schema with Session archive and attention metadata', async () => {
        const directory = await temporaryDirectory('caxri-db-schema-');
        const database = new CaxriDatabase(join(directory, 'state.db'));

        expect(database.database.pragma('user_version', { simple: true })).toBe(
            CURRENT_SCHEMA_VERSION,
        );
        expect(database.database.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(
            (database.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toContain('archived_at');
        expect(
            (database.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toEqual(
            expect.arrayContaining([
                'attention_epoch',
                'read_attention_epoch',
                'last_attention_kind',
            ]),
        );
        expect(
            (database.database.pragma('table_info(projects)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toContain('order_index');
        expect(
            (
                database.database.pragma('table_info(agent_dispatch_receipts)') as Array<{
                    name: string;
                }>
            ).map((column) => column.name),
        ).toContain('dispatch_id');
        expect(
            (database.database.pragma('table_info(terminals)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toEqual(
            expect.arrayContaining(['pty_title', 'last_agent_process_state', 'failure_detail']),
        );
        database.close();
    });

    it('deduplicates Projects by root path', async () => {
        const directory = await temporaryDirectory('caxri-db-project-dedup-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));

        const project = database.projects.create(root);

        expect(database.projects.create(root)).toMatchObject({ id: project.id, rootPath: root });
        expect(database.projects.list()).toEqual([expect.objectContaining({ id: project.id })]);
        database.close();
    });

    it('assigns increasing Project order and rewrites a complete permutation', async () => {
        const directory = await temporaryDirectory('caxri-db-project-order-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.projects.create(join(directory, 'first'));
        const second = database.projects.create(join(directory, 'second'));
        const third = database.projects.create(join(directory, 'third'));

        expect(database.projects.list().map((project) => project.orderIndex)).toEqual([0, 1, 2]);

        database.projects.reorder([third.id, first.id, second.id]);

        expect(database.projects.list().map((project) => project.id)).toEqual([
            third.id,
            first.id,
            second.id,
        ]);
        expect(database.projects.list().map((project) => project.orderIndex)).toEqual([0, 1, 2]);
        database.close();
    });

    it('cascades Project removal to Sessions and Terminals without touching the local folder', async () => {
        const directory = await temporaryDirectory('caxri-db-project-delete-');
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(root);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: root,
            title: 'Shell',
        });

        expect(database.projects.remove(project.id)).toBe(true);

        expect(await readFile(root, 'utf8')).toBe('user-owned');
        expect(database.sessions.list()).toEqual([]);
        expect(database.terminals.list()).toEqual([]);
        database.close();
    });

    it('assigns strictly increasing order_index after a middle Terminal is removed and a new one is created', async () => {
        const directory = await temporaryDirectory('caxri-db-order-index-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(root);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const insert = () =>
            database.terminals.insert({
                sessionId: session.id,
                kind: 'shell',
                cwd: root,
                title: 'Shell',
            });

        const first = insert();
        const second = insert();
        const third = insert();
        expect([first.orderIndex, second.orderIndex, third.orderIndex]).toEqual([0, 1, 2]);

        expect(database.terminals.remove(second.id)).toBe(true);
        const fourth = insert();

        expect(fourth.orderIndex).toBe(3);
        expect(fourth.orderIndex).not.toBe(third.orderIndex);
        const remainingIndexes = database.terminals
            .list(session.id)
            .map((terminal) => terminal.orderIndex);
        expect(remainingIndexes).toEqual(remainingIndexes.toSorted((a, b) => a - b));
        expect(new Set(remainingIndexes).size).toBe(remainingIndexes.length);
        database.close();
    });

    it('rejects two Terminals at the same position in one Session', async () => {
        const directory = await temporaryDirectory('caxri-db-order-unique-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(root);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const now = Date.now();
        const insertAtFirstPosition = database.database.prepare(
            `INSERT INTO terminals
             (id, session_id, kind, provider, cwd, title, icon, order_index,
              last_process_state, created_at, updated_at)
             VALUES (?, ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'stopped', ?, ?)`,
        );
        insertAtFirstPosition.run('terminal-a', session.id, root, now, now);

        expect(() => insertAtFirstPosition.run('terminal-b', session.id, root, now, now)).toThrow(
            /UNIQUE constraint failed/,
        );
        database.close();
    });

    it('rejects Terminal and Session states outside their protocol enums', async () => {
        const directory = await temporaryDirectory('caxri-db-check-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(root);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: root,
            title: 'Shell',
        });

        expect(() =>
            database.database
                .prepare("UPDATE terminals SET last_process_state = 'zombie' WHERE id = ?")
                .run(terminal.id),
        ).toThrow(/CHECK constraint failed: terminals_last_process_state/);
        expect(() =>
            database.database
                .prepare("UPDATE terminals SET failure_reason = 'spawn_failed' WHERE id = ?")
                .run(terminal.id),
        ).toThrow(/CHECK constraint failed: terminals_failure_reason_state/);
        expect(() =>
            database.database
                .prepare("UPDATE sessions SET title_mode = 'locked' WHERE id = ?")
                .run(session.id),
        ).toThrow(/CHECK constraint failed: sessions_title_mode/);
        database.close();
    });

    it('clears the primary Agent pointer when its Terminal row disappears', async () => {
        const directory = await temporaryDirectory('caxri-db-primary-agent-fk-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(root);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Agent' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'claude',
            cwd: root,
            title: 'Claude Code',
        });
        database.sessions.setPrimaryAgent(session.id, {
            primaryAgentTerminalId: terminal.id,
            displayTitle: 'Agent',
            lastActivityState: 'running',
        });

        database.terminals.remove(terminal.id);

        expect(database.sessions.get(session.id)?.primaryAgentTerminalId).toBeUndefined();
        database.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await temporaryDirectory('caxri-db-future-schema-');
        const databasePath = join(directory, 'state.db');
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 99');
        futureDatabase.close();

        expect(() => new CaxriDatabase(databasePath)).toThrow(/newer schema version/i);
    });

    it('rebuilds a pre-baseline database without touching Project files', async () => {
        const directory = await temporaryDirectory('caxri-db-layout-schema-');
        const projectRoot = join(directory, 'project');
        await writeFile(projectRoot, 'user-owned', 'utf8');
        const databasePath = join(directory, 'state.db');
        const previous = new CaxriDatabase(databasePath);
        const project = previous.projects.create(projectRoot);
        previous.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        previous.database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION - 1}`);
        previous.close();

        const rebuilt = new CaxriDatabase(databasePath);

        expect(rebuilt.projects.list()).toEqual([]);
        expect(rebuilt.sessions.list()).toEqual([]);
        expect(await readFile(projectRoot, 'utf8')).toBe('user-owned');
        rebuilt.close();
    });

    it('records worktree ownership on automatic registration and clears it on a manual add', async () => {
        const directory = await temporaryDirectory('caxri-db-project-owner-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.projects.create(join(directory, 'owner'));
        const worktreeRoot = join(directory, 'worktree');

        const registered = database.projects.create(worktreeRoot, owner.id);
        expect(registered.ownerProjectId).toBe(owner.id);
        expect(database.projects.listOwnedBy(owner.id).map(({ id }) => id)).toEqual([
            registered.id,
        ]);
        expect(owner).not.toHaveProperty('ownerProjectId');

        // Re-registration is idempotent and never re-points an existing row's ownership.
        expect(database.projects.create(worktreeRoot, owner.id)).toMatchObject({
            id: registered.id,
            ownerProjectId: owner.id,
        });

        // Adding the same root manually is an explicit user choice, so the row becomes top-level.
        const adopted = database.projects.create(worktreeRoot);
        expect(adopted.id).toBe(registered.id);
        expect(adopted).not.toHaveProperty('ownerProjectId');
        expect(database.projects.listOwnedBy(owner.id)).toEqual([]);
        database.close();
    });

    it('restricts the database and WAL sidecar files to the current user', async () => {
        const directory = await temporaryDirectory('caxri-db-permissions-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });

        const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
        const modes = await Promise.all(paths.map((path) => stat(path)));
        for (const mode of modes) expect(mode.mode & 0o777).toBe(0o600);
        database.close();
    });

    it('marks Terminals that claimed to be running as interrupted after reopening, so they can auto-restore', async () => {
        const directory = await temporaryDirectory('caxri-db-recovery-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        database.terminals.updateState(terminal.id, 'running');
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.terminals.get(terminal.id)?.lastProcessState).toBe('interrupted');
        reopened.close();
    });

    it('marks the outer Shell and Agent child as interrupted after an unclean reopen', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-recovery-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Codex' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'codex',
            cwd: directory,
            title: 'Codex',
        });
        database.terminals.updateState(terminal.id, 'running');
        database.terminals.updateAgentProcessState(terminal.id, 'running');
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.terminals.get(terminal.id)).toMatchObject({
            lastProcessState: 'interrupted',
            lastAgentProcessState: 'interrupted',
        });
        reopened.close();
    });

    /**
     * Caxri crashing is a fact about Caxri, not about any Agent conversation, so it may only touch the Terminal. Before
     * https://github.com/tjx666/caxri/issues/1124 the same reopen also stamped `failed` on every live Session, which
     * nothing could clear: a Session that was waiting on the user came back as a permanent Activity failure instead.
     */
    it('leaves every Session activity state alone after an unclean reopen', async () => {
        const directory = await temporaryDirectory('caxri-db-unclean-session-state-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const states = ['waiting', 'running', 'completed'] as const;
        const sessionIds = states.map((state) => {
            const session = database.sessions.insert({
                projectId: project.id,
                displayTitle: `Codex ${state}`,
            });
            const terminal = database.terminals.insert({
                sessionId: session.id,
                kind: 'codex',
                cwd: directory,
                title: 'Codex',
            });
            database.terminals.updateState(terminal.id, 'running');
            database.terminals.updateAgentProcessState(terminal.id, 'running');
            database.sessions.setPrimaryAgent(session.id, {
                primaryAgentTerminalId: terminal.id,
                displayTitle: session.displayTitle,
                lastActivityState: state,
            });
            return { sessionId: session.id, state, terminalId: terminal.id };
        });
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        for (const { sessionId, state, terminalId } of sessionIds) {
            expect(reopened.sessions.get(sessionId)?.lastActivityState).toBe(state);
            // The interruption is still recorded, just on the Terminal that actually suffered it.
            expect(reopened.terminals.get(terminalId)?.lastProcessState).toBe('interrupted');
        }
        reopened.close();
    });

    it.each(['orderly', 'terminate'] as const)(
        'preserves conversation activity across %s shutdown and reopen',
        async (reason) => {
            const directory = await temporaryDirectory('caxri-db-session-shutdown-');
            const databasePath = join(directory, 'state.db');
            const database = new CaxriDatabase(databasePath);
            const project = database.projects.create(directory);
            const records = (['waiting', 'running', 'completed'] as const).map((state) => {
                const session = database.sessions.insert({
                    projectId: project.id,
                    displayTitle: `Conversation ${state}`,
                });
                const terminal = database.terminals.insert({
                    sessionId: session.id,
                    kind: 'codex',
                    cwd: directory,
                    title: 'Codex',
                });
                database.terminals.updateState(terminal.id, 'running');
                database.terminals.updateAgentProcessState(terminal.id, 'running');
                database.sessions.setPrimaryAgent(session.id, {
                    primaryAgentTerminalId: terminal.id,
                    displayTitle: session.displayTitle,
                    lastActivityState: state,
                });
                return { sessionId: session.id, terminalId: terminal.id, state };
            });
            database.markShutdown(reason);
            database.close();

            const reopened = new CaxriDatabase(databasePath);
            try {
                for (const { sessionId, terminalId, state } of records) {
                    expect(reopened.sessions.get(sessionId)?.lastActivityState).toBe(state);
                    expect(reopened.terminals.get(terminalId)).toMatchObject({
                        lastProcessState: reason === 'terminate' ? 'stopped' : 'interrupted',
                        lastAgentProcessState: reason === 'terminate' ? 'stopped' : 'interrupted',
                    });
                }
            } finally {
                reopened.close();
            }
        },
    );

    it('marks running Terminals as interrupted for an orderly shutdown, keeping the Session resumable', async () => {
        const directory = await temporaryDirectory('caxri-db-shutdown-orderly-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        database.terminals.updateState(terminal.id, 'running');

        database.markShutdown('orderly');

        expect(database.terminals.get(terminal.id)?.lastProcessState).toBe('interrupted');
        database.close();
    });

    it('marks running Terminals as stopped for an explicit terminate shutdown', async () => {
        const directory = await temporaryDirectory('caxri-db-shutdown-terminate-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.projects.create(directory);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = database.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        database.terminals.updateState(terminal.id, 'running');

        database.markShutdown('terminate');

        expect(database.terminals.get(terminal.id)?.lastProcessState).toBe('stopped');
        database.close();
    });
});

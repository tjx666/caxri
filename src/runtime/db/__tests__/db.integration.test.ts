import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { CaxriDb } from '../index';
import { CURRENT_SCHEMA_VERSION } from '../connection';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function tempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

describe('CaxriDb', () => {
    it('creates the current schema with reversible Session archive metadata', async () => {
        const directory = await tempDir('caxri-db-schema-');
        const db = new CaxriDb(join(directory, 'state.db'));

        expect(db.database.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
        expect(
            (db.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toContain('archived_at');
        db.close();
    });

    it('deduplicates Projects by root path', async () => {
        const directory = await tempDir('caxri-db-project-dedup-');
        const root = join(directory, 'project');
        await mkdir(root);
        const db = new CaxriDb(join(directory, 'state.db'));

        const project = db.projects.create(root);

        expect(db.projects.create(root)).toMatchObject({ id: project.id, rootPath: root });
        expect(db.projects.list()).toEqual([expect.objectContaining({ id: project.id })]);
        db.close();
    });

    it('cascades Project removal to Sessions and Terminals without touching the local directory', async () => {
        const directory = await tempDir('caxri-db-project-delete-');
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const db = new CaxriDb(join(directory, 'state.db'));
        const project = db.projects.create(root);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        db.terminals.insert({ sessionId: session.id, kind: 'shell', cwd: root, title: 'Shell' });

        expect(db.projects.remove(project.id)).toBe(true);

        expect(await readFile(root, 'utf8')).toBe('user-owned');
        expect(db.sessions.list()).toEqual([]);
        expect(db.terminals.list()).toEqual([]);
        db.close();
    });

    it('assigns strictly increasing order_index after a middle Terminal is removed and a new one is created', async () => {
        const directory = await tempDir('caxri-db-order-index-');
        const root = join(directory, 'project');
        await mkdir(root);
        const db = new CaxriDb(join(directory, 'state.db'));
        const project = db.projects.create(root);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const insert = () =>
            db.terminals.insert({
                sessionId: session.id,
                kind: 'shell',
                cwd: root,
                title: 'Shell',
            });

        const first = insert();
        const second = insert();
        const third = insert();
        expect([first.orderIndex, second.orderIndex, third.orderIndex]).toEqual([0, 1, 2]);

        expect(db.terminals.remove(second.id)).toBe(true);
        const fourth = insert();

        expect(fourth.orderIndex).toBe(3);
        expect(fourth.orderIndex).not.toBe(third.orderIndex);
        const remainingIndexes = db.terminals
            .list(session.id)
            .map((terminal) => terminal.orderIndex);
        expect(remainingIndexes).toEqual([...remainingIndexes].sort((a, b) => a - b));
        expect(new Set(remainingIndexes).size).toBe(remainingIndexes.length);
        db.close();
    });

    it('breaks ties on id when legacy rows share the same order_index', async () => {
        const directory = await tempDir('caxri-db-order-tiebreak-');
        const root = join(directory, 'project');
        await mkdir(root);
        const db = new CaxriDb(join(directory, 'state.db'));
        const project = db.projects.create(root);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        /** Simulate pre-fix legacy data where two Terminals collided on the same order_index. */
        const now = Date.now();
        db.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id,
                  last_process_state, created_at, updated_at)
                 VALUES ('terminal-b', ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'layout-b', 'stopped', ?, ?)`,
            )
            .run(session.id, root, now, now);
        db.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id,
                  last_process_state, created_at, updated_at)
                 VALUES ('terminal-a', ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'layout-a', 'stopped', ?, ?)`,
            )
            .run(session.id, root, now, now);

        expect(db.terminals.list(session.id).map((terminal) => terminal.id)).toEqual([
            'terminal-a',
            'terminal-b',
        ]);
        db.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await tempDir('caxri-db-future-schema-');
        const databasePath = join(directory, 'state.db');
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 99');
        futureDatabase.close();

        expect(() => new CaxriDb(databasePath)).toThrow(/newer schema version/i);
    });

    it('rebuilds pre-release metadata without touching Project files', async () => {
        const directory = await tempDir('caxri-db-layout-schema-');
        const projectRoot = join(directory, 'project');
        await writeFile(projectRoot, 'user-owned', 'utf8');
        const databasePath = join(directory, 'state.db');
        const previous = new CaxriDb(databasePath);
        const project = previous.projects.create(projectRoot);
        previous.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        previous.database.pragma('user_version = 2');
        previous.close();

        const rebuilt = new CaxriDb(databasePath);

        expect(rebuilt.projects.list()).toEqual([]);
        expect(rebuilt.sessions.list()).toEqual([]);
        expect(await readFile(projectRoot, 'utf8')).toBe('user-owned');
        rebuilt.close();
    });

    it('restricts the database and WAL sidecar files to the current user', async () => {
        const directory = await tempDir('caxri-db-permissions-');
        const databasePath = join(directory, 'state.db');
        const db = new CaxriDb(databasePath);
        const project = db.projects.create(directory);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        db.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });

        for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
        db.close();
    });

    it('marks Terminals that claimed to be running as interrupted after reopening, so they can auto-restore', async () => {
        const directory = await tempDir('caxri-db-recovery-');
        const databasePath = join(directory, 'state.db');
        const db = new CaxriDb(databasePath);
        const project = db.projects.create(directory);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = db.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        db.terminals.updateState(terminal.id, 'running');
        db.close();

        const reopened = new CaxriDb(databasePath);
        expect(reopened.terminals.get(terminal.id)?.lastProcessState).toBe('interrupted');
        reopened.close();
    });

    it('marks running Terminals as interrupted for an orderly shutdown, keeping the Session resumable', async () => {
        const directory = await tempDir('caxri-db-shutdown-orderly-');
        const databasePath = join(directory, 'state.db');
        const db = new CaxriDb(databasePath);
        const project = db.projects.create(directory);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = db.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        db.terminals.updateState(terminal.id, 'running');

        db.markShutdown('orderly');

        expect(db.terminals.get(terminal.id)?.lastProcessState).toBe('interrupted');
        db.close();
    });

    it('marks running Terminals as stopped for an explicit terminate shutdown', async () => {
        const directory = await tempDir('caxri-db-shutdown-terminate-');
        const databasePath = join(directory, 'state.db');
        const db = new CaxriDb(databasePath);
        const project = db.projects.create(directory);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = db.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        db.terminals.updateState(terminal.id, 'running');

        db.markShutdown('terminate');

        expect(db.terminals.get(terminal.id)?.lastProcessState).toBe('stopped');
        db.close();
    });

    it('treats session_state.active_tab_json as an opaque round-tripped blob', async () => {
        const directory = await tempDir('caxri-db-active-tab-');
        const databasePath = join(directory, 'state.db');
        const db = new CaxriDb(databasePath);
        const project = db.projects.create(directory);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = db.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        db.sessions.insertInitialState(session.id, terminal.id);
        /** The shape here is opaque to the db: a legacy path string round-trips exactly like an
            arbitrary structured object would. */
        const structuredActiveTab = { kind: 'file', path: '/a.ts' } as unknown as ReturnType<
            typeof db.sessions.getState
        >['activeTab'];

        db.sessions.updateState({
            ...db.sessions.getState(session.id),
            activeTab: structuredActiveTab,
        });

        expect(db.sessions.getState(session.id).activeTab).toEqual(structuredActiveTab);
        db.close();
    });

    it('loads all Session states in one ordered query', async () => {
        const directory = await tempDir('caxri-db-session-states-');
        const db = new CaxriDb(join(directory, 'state.db'));
        const project = db.projects.create(directory);
        const first = db.sessions.insert({ projectId: project.id, displayTitle: 'First' });
        const second = db.sessions.insert({ projectId: project.id, displayTitle: 'Second' });
        const insertTerminal = (sessionId: string) =>
            db.terminals.insert({
                sessionId,
                kind: 'shell',
                cwd: directory,
                title: 'Shell',
            });
        db.sessions.insertInitialState(first.id, insertTerminal(first.id).id);
        db.sessions.insertInitialState(second.id, insertTerminal(second.id).id);

        expect(db.sessions.listStates().map((state) => state.sessionId)).toEqual(
            db.sessions.list().map((session) => session.id),
        );
        db.close();
    });
});

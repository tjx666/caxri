import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { CaxriStore } from '../index';

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

describe('CaxriStore', () => {
    it('deduplicates Projects by root path', async () => {
        const directory = await tempDir('caxri-store-project-dedup-');
        const root = join(directory, 'project');
        await mkdir(root);
        const store = new CaxriStore(join(directory, 'state.db'));

        const project = store.projects.create(root);

        expect(store.projects.create(root)).toMatchObject({ id: project.id, rootPath: root });
        expect(store.projects.list()).toEqual([expect.objectContaining({ id: project.id })]);
        store.close();
    });

    it('cascades Project removal to Sessions and Terminals without touching the local directory', async () => {
        const directory = await tempDir('caxri-store-project-delete-');
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const store = new CaxriStore(join(directory, 'state.db'));
        const project = store.projects.create(root);
        const session = store.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        store.terminals.insert({ sessionId: session.id, kind: 'shell', cwd: root, title: 'Shell' });

        expect(store.projects.remove(project.id)).toBe(true);

        expect(await readFile(root, 'utf8')).toBe('user-owned');
        expect(store.sessions.list()).toEqual([]);
        expect(store.terminals.list()).toEqual([]);
        store.close();
    });

    it('assigns strictly increasing order_index after a middle Terminal is removed and a new one is created', async () => {
        const directory = await tempDir('caxri-store-order-index-');
        const root = join(directory, 'project');
        await mkdir(root);
        const store = new CaxriStore(join(directory, 'state.db'));
        const project = store.projects.create(root);
        const session = store.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const insert = () =>
            store.terminals.insert({ sessionId: session.id, kind: 'shell', cwd: root, title: 'Shell' });

        const first = insert();
        const second = insert();
        const third = insert();
        expect([first.orderIndex, second.orderIndex, third.orderIndex]).toEqual([0, 1, 2]);

        expect(store.terminals.remove(second.id)).toBe(true);
        const fourth = insert();

        expect(fourth.orderIndex).toBe(3);
        expect(fourth.orderIndex).not.toBe(third.orderIndex);
        const remainingIndexes = store.terminals
            .list(session.id)
            .map((terminal) => terminal.orderIndex);
        expect(remainingIndexes).toEqual([...remainingIndexes].sort((a, b) => a - b));
        expect(new Set(remainingIndexes).size).toBe(remainingIndexes.length);
        store.close();
    });

    it('breaks ties on id when legacy rows share the same order_index', async () => {
        const directory = await tempDir('caxri-store-order-tiebreak-');
        const root = join(directory, 'project');
        await mkdir(root);
        const store = new CaxriStore(join(directory, 'state.db'));
        const project = store.projects.create(root);
        const session = store.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        /** Simulate pre-fix legacy data where two Terminals collided on the same order_index. */
        const now = Date.now();
        store.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id,
                  last_process_state, created_at, updated_at)
                 VALUES ('terminal-b', ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'layout-b', 'stopped', ?, ?)`,
            )
            .run(session.id, root, now, now);
        store.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id,
                  last_process_state, created_at, updated_at)
                 VALUES ('terminal-a', ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'layout-a', 'stopped', ?, ?)`,
            )
            .run(session.id, root, now, now);

        expect(store.terminals.list(session.id).map((terminal) => terminal.id)).toEqual([
            'terminal-a',
            'terminal-b',
        ]);
        store.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await tempDir('caxri-store-future-schema-');
        const databasePath = join(directory, 'state.db');
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 99');
        futureDatabase.close();

        expect(() => new CaxriStore(databasePath)).toThrow(/newer schema version/i);
    });

    it('rebuilds pre-release metadata without touching Project files', async () => {
        const directory = await tempDir('caxri-store-layout-schema-');
        const projectRoot = join(directory, 'project');
        await writeFile(projectRoot, 'user-owned', 'utf8');
        const databasePath = join(directory, 'state.db');
        const previous = new CaxriStore(databasePath);
        const project = previous.projects.create(projectRoot);
        previous.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        previous.database.pragma('user_version = 2');
        previous.close();

        const rebuilt = new CaxriStore(databasePath);

        expect(rebuilt.projects.list()).toEqual([]);
        expect(rebuilt.sessions.list()).toEqual([]);
        expect(await readFile(projectRoot, 'utf8')).toBe('user-owned');
        rebuilt.close();
    });

    it('restricts the database and WAL sidecar files to the current user', async () => {
        const directory = await tempDir('caxri-store-permissions-');
        const databasePath = join(directory, 'state.db');
        const store = new CaxriStore(databasePath);
        const project = store.projects.create(directory);
        const session = store.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        store.terminals.insert({ sessionId: session.id, kind: 'shell', cwd: directory, title: 'Shell' });

        for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
        store.close();
    });

    it('marks Terminals that claimed to be running as dead after reopening', async () => {
        const directory = await tempDir('caxri-store-recovery-');
        const databasePath = join(directory, 'state.db');
        const store = new CaxriStore(databasePath);
        const project = store.projects.create(directory);
        const session = store.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = store.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        store.terminals.updateState(terminal.id, 'running');
        store.close();

        const reopened = new CaxriStore(databasePath);
        expect(reopened.terminals.get(terminal.id)?.lastProcessState).toBe('dead');
        reopened.close();
    });

    it('treats session_state.active_tab_json as an opaque round-tripped blob', async () => {
        const directory = await tempDir('caxri-store-active-tab-');
        const databasePath = join(directory, 'state.db');
        const store = new CaxriStore(databasePath);
        const project = store.projects.create(directory);
        const session = store.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = store.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        store.sessions.insertInitialState(session.id, terminal.id);
        /** The shape here is opaque to the store: a legacy path string round-trips exactly like an
            arbitrary structured object would. */
        const structuredActiveTab = { kind: 'file', path: '/a.ts' } as unknown as ReturnType<
            typeof store.sessions.getState
        >['activeTab'];

        store.sessions.updateState({ ...store.sessions.getState(session.id), activeTab: structuredActiveTab });

        expect(store.sessions.getState(session.id).activeTab).toEqual(structuredActiveTab);
        store.close();
    });
});

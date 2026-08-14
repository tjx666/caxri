import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { createTerminalLayout } from '../../../shared/terminal-layout';
import { CaxriDb } from '../index';
import { CURRENT_SCHEMA_VERSION } from '../connection';
import { migrationManifest, PRESERVED_SCHEMA_VERSION } from '../migrations/manifest';

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
    it('creates the current schema with Session archive and attention metadata', async () => {
        const directory = await tempDir('caxri-db-schema-');
        const db = new CaxriDb(join(directory, 'state.db'));

        expect(db.database.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
        expect(db.appState.get<number>('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
        expect(
            (db.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toContain('archived_at');
        expect(
            (db.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
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
            (db.database.pragma('table_info(projects)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).toContain('order_index');
        expect(
            (
                db.database.pragma('table_info(agent_dispatch_receipts)') as Array<{ name: string }>
            ).map((column) => column.name),
        ).toContain('dispatch_id');
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

    it('assigns increasing Project order and rewrites a complete permutation', async () => {
        const directory = await tempDir('caxri-db-project-order-');
        const db = new CaxriDb(join(directory, 'state.db'));
        const first = db.projects.create(join(directory, 'first'));
        const second = db.projects.create(join(directory, 'second'));
        const third = db.projects.create(join(directory, 'third'));

        expect(db.projects.list().map((project) => project.orderIndex)).toEqual([0, 1, 2]);

        db.projects.reorder([third.id, first.id, second.id]);

        expect(db.projects.list().map((project) => project.id)).toEqual([
            third.id,
            first.id,
            second.id,
        ]);
        expect(db.projects.list().map((project) => project.orderIndex)).toEqual([0, 1, 2]);
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

    it('migrates the preservation-floor schema without losing metadata', async () => {
        const directory = await tempDir('caxri-db-preservation-floor-');
        const databasePath = join(directory, 'state.db');
        const floorDatabase = new Database(databasePath);
        floorDatabase.pragma('foreign_keys = ON');
        for (const migration of migrationManifest.slice(0, 2)) {
            floorDatabase.exec(migration.sql.replaceAll('--> statement-breakpoint', ''));
        }
        floorDatabase
            .prepare(
                `INSERT INTO projects
                 (id, root_path, display_title, created_at, last_opened_at)
                 VALUES ('project-floor', ?, 'Preserved Project', 1, 1)`,
            )
            .run(directory);
        floorDatabase
            .prepare(
                `INSERT INTO sessions
                 (id, project_id, created_at, last_opened_at, primary_agent_terminal_id,
                  last_activity_state, layout_version, display_title, archived_at)
                 VALUES ('session-floor', 'project-floor', 1, 1, NULL, 'idle', 2,
                         'Preserved Session', NULL)`,
            )
            .run();
        floorDatabase.pragma(`user_version = ${PRESERVED_SCHEMA_VERSION}`);
        floorDatabase.close();

        const upgraded = new CaxriDb(databasePath);

        expect(upgraded.projects.get('project-floor')).toMatchObject({
            displayTitle: 'Preserved Project',
            orderIndex: 0,
        });
        expect(upgraded.sessions.get('session-floor')).toMatchObject({
            displayTitle: 'Preserved Session',
            titleMode: 'automatic',
        });
        expect(upgraded.database.pragma('user_version', { simple: true })).toBe(
            CURRENT_SCHEMA_VERSION,
        );
        expect(upgraded.appState.get<number>('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
        upgraded.close();
    });

    it('migrates the previous preserved schema without losing metadata or snapshots', async () => {
        const directory = await tempDir('caxri-db-preserved-upgrade-');
        const databasePath = join(directory, 'state.db');
        const previous = new Database(databasePath);
        previous.pragma('foreign_keys = ON');
        for (const migration of migrationManifest.slice(0, -1))
            previous.exec(migration.sql.replaceAll('--> statement-breakpoint', ''));
        const project = { id: 'project-current', rootPath: directory };
        const oldestProject = { id: 'project-oldest', rootPath: join(directory, 'oldest') };
        const middleProject = { id: 'project-middle', rootPath: join(directory, 'middle') };
        const insertProject = previous.prepare(
            `INSERT INTO projects
             (id, root_path, display_title, order_index, created_at, last_opened_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        );
        insertProject.run(project.id, project.rootPath, 'Current', 0, 1, 1);
        insertProject.run(oldestProject.id, oldestProject.rootPath, 'Oldest', 1, 2, 2);
        insertProject.run(middleProject.id, middleProject.rootPath, 'Middle', 2, 3, 3);
        previous
            .prepare(
                `INSERT INTO sessions
                 (id, project_id, created_at, last_opened_at, primary_agent_terminal_id,
                  last_activity_state, layout_version, display_title, archived_at, title_mode,
                  attention_epoch, read_attention_epoch, last_attention_kind)
                 VALUES ('session-preserved', ?, 1, 1, NULL, 'idle', 2, 'Shell', NULL,
                         'automatic', 0, 0, NULL)`,
            )
            .run(project.id);
        previous
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-preserved', 'session-preserved', 'shell', NULL, ?, 'Shell',
                         'shell', 0, 'node-preserved', NULL, 'stopped', NULL, 1, 1)`,
            )
            .run(directory);
        previous
            .prepare(
                `INSERT INTO session_state
                 (session_id, open_tabs_json, active_tab_json, inspector_mode, layout_json,
                  state_version, editor_remap_operation_id)
                 VALUES ('session-preserved', '[]', NULL, 'files', ?, 1, NULL)`,
            )
            .run(
                JSON.stringify(createTerminalLayout('terminal-preserved', () => 'group-preserved')),
            );
        previous
            .prepare(
                `INSERT INTO terminal_snapshots
                 (terminal_id, encoding_version, line_count, byte_count, payload, updated_at)
                 VALUES ('terminal-preserved', 1, 1, 8, 'restored', 123)`,
            )
            .run();
        previous.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        previous.close();

        const upgraded = new CaxriDb(databasePath);

        expect(upgraded.database.pragma('user_version', { simple: true })).toBe(
            CURRENT_SCHEMA_VERSION,
        );
        expect(upgraded.appState.get<number>('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
        expect(upgraded.database.pragma('table_info(agent_dispatch_receipts)')).not.toHaveLength(0);
        expect(
            (upgraded.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toEqual(
            expect.arrayContaining([
                'workbench_project_id',
                'workbench_root_device',
                'workbench_root_inode',
            ]),
        );
        expect(upgraded.projects.list()).toEqual([
            expect.objectContaining({ id: project.id, orderIndex: 0 }),
            expect.objectContaining({ id: oldestProject.id, orderIndex: 1 }),
            expect.objectContaining({ id: middleProject.id, orderIndex: 2 }),
        ]);
        expect(upgraded.sessions.get('session-preserved')).toMatchObject({
            attentionEpoch: 0,
            id: 'session-preserved',
            projectId: project.id,
            workbenchProjectId: project.id,
            displayTitle: 'Shell',
            hasUnread: false,
            readAttentionEpoch: 0,
            titleMode: 'automatic',
        });
        expect(upgraded.terminals.get('terminal-preserved')).toMatchObject({
            id: 'terminal-preserved',
            failureReason: undefined,
        });
        expect(upgraded.snapshots.get('terminal-preserved')).toMatchObject({
            terminalId: 'terminal-preserved',
            payload: 'restored',
        });
        const restoredState = upgraded.sessions.getState('session-preserved');
        expect(restoredState.workbenchProjectId).toBe(project.id);
        expect(restoredState.layout).not.toEqual({});
        upgraded.close();
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

    it('round-trips a valid structured active WorkItem', async () => {
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
        const structuredActiveTab = { kind: 'editor', path: '/a.ts' } as const;

        db.sessions.updateState({
            ...db.sessions.getState(session.id),
            activeTab: structuredActiveTab,
            editorRemapOperationId: 'operation-1',
        });

        expect(db.sessions.getState(session.id).activeTab).toEqual(structuredActiveTab);
        expect(db.sessions.getState(session.id).editorRemapOperationId).toBe('operation-1');
        db.close();
    });

    it('never persists dirty tabs without their Renderer-owned document bodies', async () => {
        const directory = await tempDir('caxri-db-clean-tabs-');
        const db = new CaxriDb(join(directory, 'state.db'));
        const project = db.projects.create(directory);
        const session = db.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        const terminal = db.terminals.insert({
            sessionId: session.id,
            kind: 'shell',
            cwd: directory,
            title: 'Shell',
        });
        db.sessions.insertInitialState(session.id, terminal.id);

        db.sessions.updateState({
            ...db.sessions.getState(session.id),
            openTabs: [{ path: '/project/unsaved.ts', dirty: true }],
        });

        expect(db.sessions.getState(session.id).openTabs).toEqual([
            { path: '/project/unsaved.ts', dirty: false },
        ]);
        expect(
            JSON.parse(
                (
                    db.database
                        .prepare('SELECT open_tabs_json FROM session_state WHERE session_id = ?')
                        .get(session.id) as { open_tabs_json: string }
                ).open_tabs_json,
            ),
        ).toEqual([{ path: '/project/unsaved.ts', dirty: false }]);

        db.database
            .prepare(
                "UPDATE session_state SET open_tabs_json = ?, workbench_state_json = '{}' WHERE session_id = ?",
            )
            .run(JSON.stringify([{ path: '/project/legacy.ts', dirty: true }]), session.id);
        expect(db.sessions.getState(session.id).openTabs).toEqual([
            { path: '/project/legacy.ts', dirty: false },
        ]);
        expect(
            JSON.parse(
                (
                    db.database
                        .prepare('SELECT open_tabs_json FROM session_state WHERE session_id = ?')
                        .get(session.id) as { open_tabs_json: string }
                ).open_tabs_json,
            ),
        ).toEqual([{ path: '/project/legacy.ts', dirty: false }]);
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

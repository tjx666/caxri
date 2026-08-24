import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listPaneTerminalIds } from '../../../shared/pane-layout';
import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabaseConnection as CaxriDatabase } from '../index';
import { migrationManifest, PRESERVED_SCHEMA_VERSION } from '../migrations/manifest';

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
    it('creates the current schema with Session archive and attention metadata', async () => {
        const directory = await temporaryDirectory('caxri-db-schema-');
        const database = new CaxriDatabase(join(directory, 'state.db'));

        expect(database.database.pragma('user_version', { simple: true })).toBe(
            CURRENT_SCHEMA_VERSION,
        );
        expect(database.appState.get('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
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
        ).toContain('pty_title');
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

    it('cascades Project removal to Sessions and Terminals without touching the local directory', async () => {
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

    it('breaks ties on id when legacy rows share the same order_index', async () => {
        const directory = await temporaryDirectory('caxri-db-order-tiebreak-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(root);
        const session = database.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        /**
         * Simulate pre-fix legacy data where two Terminals collided on the same order_index.
         */
        const now = Date.now();
        database.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index,
                  last_process_state, created_at, updated_at)
                 VALUES ('terminal-b', ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'stopped', ?, ?)`,
            )
            .run(session.id, root, now, now);
        database.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index,
                  last_process_state, created_at, updated_at)
                 VALUES ('terminal-a', ?, 'shell', NULL, ?, 'Shell', 'shell', 0, 'stopped', ?, ?)`,
            )
            .run(session.id, root, now, now);

        expect(database.terminals.list(session.id).map((terminal) => terminal.id)).toEqual([
            'terminal-a',
            'terminal-b',
        ]);
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

    it('rebuilds pre-release metadata without touching Project files', async () => {
        const directory = await temporaryDirectory('caxri-db-layout-schema-');
        const projectRoot = join(directory, 'project');
        await writeFile(projectRoot, 'user-owned', 'utf8');
        const databasePath = join(directory, 'state.db');
        const previous = new CaxriDatabase(databasePath);
        const project = previous.projects.create(projectRoot);
        previous.sessions.insert({ projectId: project.id, displayTitle: 'Shell' });
        previous.database.pragma('user_version = 2');
        previous.close();

        const rebuilt = new CaxriDatabase(databasePath);

        expect(rebuilt.projects.list()).toEqual([]);
        expect(rebuilt.sessions.list()).toEqual([]);
        expect(await readFile(projectRoot, 'utf8')).toBe('user-owned');
        rebuilt.close();
    });

    it('migrates the preservation-floor schema without losing metadata', async () => {
        const directory = await temporaryDirectory('caxri-db-preservation-floor-');
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

        const upgraded = new CaxriDatabase(databasePath);

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
        expect(upgraded.appState.get('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
        upgraded.close();
    });

    it('migrates the previous preserved schema without losing metadata or snapshots', async () => {
        const directory = await temporaryDirectory('caxri-db-preserved-upgrade-');
        const databasePath = join(directory, 'state.db');
        const previous = new Database(databasePath);
        previous.pragma('foreign_keys = ON');
        const migrationsWithoutLatest = migrationManifest.slice(0, -1);
        for (const migration of migrationsWithoutLatest)
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
                 (id, session_id, kind, provider, cwd, title, icon, order_index,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-preserved', 'session-preserved', 'shell', NULL, ?,
                         'zsh old-project', 'shell', 0, NULL, 'stopped', NULL, 1, 1)`,
            )
            .run(directory);
        previous
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-claude', 'session-preserved', 'claude', 'claude', ?,
                         'claude working', 'claude', 1, NULL, 'stopped', NULL, 1, 1)`,
            )
            .run(directory);
        previous
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-codex', 'session-preserved', 'codex', 'codex', ?,
                         'codex reviewing', 'codex', 2, NULL, 'stopped', NULL, 1, 1)`,
            )
            .run(directory);
        previous
            .prepare(
                `INSERT INTO session_state
                 (session_id, state_version, workbench_state_json,
                  desired_secondary_sidebar_view_container_id)
                 VALUES ('session-preserved', 2, '{}', 'publisher.missing')`,
            )
            .run();
        previous
            .prepare(
                `INSERT INTO terminal_snapshots
                 (terminal_id, encoding_version, line_count, byte_count, payload, updated_at)
                 VALUES ('terminal-preserved', 1, 1, 8, 'restored', 123)`,
            )
            .run();
        previous.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        previous.close();

        const upgraded = new CaxriDatabase(databasePath);

        expect(upgraded.database.pragma('user_version', { simple: true })).toBe(
            CURRENT_SCHEMA_VERSION,
        );
        expect(upgraded.appState.get('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
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
        expect(upgraded.projects.get(project.id)).not.toHaveProperty('icon');
        expect(
            (upgraded.database.pragma('table_info(projects)') as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toEqual(expect.arrayContaining(['icon_name', 'icon_color']));
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
            ptyTitle: 'zsh old-project',
            title: 'Shell',
        });
        expect(upgraded.terminals.get('terminal-claude')).toMatchObject({
            ptyTitle: 'claude working',
            title: 'Claude Code',
        });
        expect(upgraded.terminals.get('terminal-codex')).toMatchObject({
            ptyTitle: 'codex reviewing',
            title: 'Codex',
        });
        expect(upgraded.snapshots.get('terminal-preserved')).toBeUndefined();
        expect(
            upgraded.database
                .prepare(
                    `SELECT terminal_id AS terminalId, payload, cols, rows
                     FROM terminal_snapshots WHERE terminal_id = ?`,
                )
                .get('terminal-preserved'),
        ).toEqual({
            cols: null,
            payload: 'restored',
            rows: null,
            terminalId: 'terminal-preserved',
        });
        const restoredState = upgraded.sessions.getState('session-preserved');
        expect(restoredState.workbenchProjectId).toBe(project.id);
        expect(restoredState.desiredSecondarySidebarViewContainerId).toBe('publisher.missing');
        expect(listPaneTerminalIds(restoredState.paneLayout)).toEqual([
            'terminal-preserved',
            'terminal-claude',
            'terminal-codex',
        ]);
        upgraded.close();
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

    it('round-trips editorRemapOperationId together with the pane layout', async () => {
        const directory = await temporaryDirectory('caxri-db-remap-operation-');
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

    it('round-trips extension tree state independently for each Session', async () => {
        const directory = await temporaryDirectory('caxri-db-extension-tree-state-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const first = database.sessions.insert({ projectId: project.id, displayTitle: 'First' });
        const second = database.sessions.insert({ projectId: project.id, displayTitle: 'Second' });
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
        });

        expect(database.sessions.getState(first.id).extensionTreeViewStates).toEqual({
            'publisher.fixture.tree': {
                expandedItemIds: ['repository'],
                initializedItemIds: ['repository'],
                focusedItemId: 'repository',
            },
        });
        expect(database.sessions.getState(second.id).extensionTreeViewStates).toBeUndefined();
        database.close();
    });

    it('loads all Session states with one Terminal ownership query', async () => {
        const directory = await temporaryDirectory('caxri-db-session-states-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.projects.create(directory);
        const first = database.sessions.insert({ projectId: project.id, displayTitle: 'First' });
        const second = database.sessions.insert({ projectId: project.id, displayTitle: 'Second' });
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

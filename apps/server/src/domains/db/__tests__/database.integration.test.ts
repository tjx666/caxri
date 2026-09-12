import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPaneTerminalIds } from '@caxri/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import type { DatabaseTransactionObservation } from '../database-connection';
import { CaxriDatabaseConnection as CaxriDatabase } from '../index';
import {
    migrationManifest,
    PRESERVED_SCHEMA_VERSION,
    schemaVersionForMigration,
} from '../migrations/manifest';

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
        expect(database.appState.get('schemaVersion')).toBe(CURRENT_SCHEMA_VERSION);
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
        ).toEqual(expect.arrayContaining(['pty_title', 'last_agent_process_state']));
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
        expect(upgraded.database.pragma('foreign_keys', { simple: true })).toBe(1);
        upgraded.close();
    });

    it('migrates the schema before removing automatic naming without losing metadata or snapshots', async () => {
        const directory = await temporaryDirectory('caxri-db-preserved-upgrade-');
        const databasePath = join(directory, 'state.db');
        const previous = new Database(databasePath);
        previous.pragma('foreign_keys = ON');
        const migrationsWithoutLatest = migrationManifest.slice(
            0,
            migrationManifest.findIndex((migration) => migration.tag === '0022_natural_apocalypse'),
        );
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
                  attention_epoch, read_attention_epoch, last_attention_kind,
                  last_session_activity_at, last_session_activity_reason)
                 VALUES ('session-preserved', ?, 1, 1, NULL, 'idle', 2, 'Shell', NULL,
                         'automatic', 0, 0, NULL, 1, 'created')`,
            )
            .run(project.id);
        previous
            .prepare(
                `INSERT INTO sessions
                 (id, project_id, created_at, last_opened_at, primary_agent_terminal_id,
                  last_activity_state, layout_version, display_title, archived_at, title_mode,
                  attention_epoch, read_attention_epoch, last_attention_kind,
                  last_session_activity_at, last_session_activity_reason)
                 VALUES ('session-manual', ?, 2, 2, NULL, 'idle', 2, 'Keep this title', NULL,
                         'manual', 0, 0, NULL, 2, 'created')`,
            )
            .run(project.id);
        previous
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, pty_title, icon, order_index,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-preserved', 'session-preserved', 'shell', NULL, ?,
                         'Shell', 'zsh old-project', 'shell', 0, NULL, 'stopped', NULL, 1, 1)`,
            )
            .run(directory);
        previous
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, pty_title, icon, order_index,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-claude', 'session-preserved', 'claude', 'claude', ?,
                         'Claude Code', 'claude working', 'claude', 1, NULL, 'stopped', NULL, 1, 1)`,
            )
            .run(directory);
        previous
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, pty_title, icon, order_index,
                  agent_session_id, last_process_state, failure_reason, created_at, updated_at)
                 VALUES ('terminal-codex', 'session-preserved', 'codex', 'codex', ?,
                         'Codex', 'codex reviewing', 'codex', 2, NULL, 'running', NULL, 1, 1)`,
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
        /**
         * The previous released schema had already run migration 0018's one-time semantic backfill. Applying generated
         * SQL above reconstructs its columns only, so reproduce that prior-version runtime state before testing 0019.
         */
        previous
            .prepare(
                "UPDATE terminals SET last_agent_process_state = last_process_state WHERE kind <> 'shell' OR provider IS NOT NULL",
            )
            .run();
        /**
         * The previous released schema still carried Caxri's private automatic-naming columns and the outcome of their
         * one-time backfill. Seeding that real prior-version state is what makes the assertions below prove migration
         * 0022 drops the mirror without disturbing the user-visible title or its manual ownership.
         */
        previous
            .prepare(
                "UPDATE sessions SET auto_naming_state = 'stopped', last_auto_title = 'Generated' WHERE title_mode = 'manual'",
            )
            .run();
        previous.pragma(`user_version = ${schemaVersionForMigration('0021_mature_xavin')}`);
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
                'last_session_activity_at',
                'last_session_activity_reason',
                'automatic_naming',
            ]),
        );
        /**
         * The retired naming mirror stays absent; the new synchronization intent does not alter manual ownership.
         */
        expect(
            (upgraded.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toEqual(expect.not.arrayContaining(['auto_naming_state', 'last_auto_title']));
        expect(
            (upgraded.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toContain('title_mode');
        expect(upgraded.projects.list()).toEqual([
            expect.objectContaining({ id: project.id, orderIndex: 0 }),
            expect.objectContaining({ id: oldestProject.id, orderIndex: 1 }),
            expect.objectContaining({ id: middleProject.id, orderIndex: 2 }),
        ]);
        expect(
            (upgraded.database.pragma('table_info(terminals)') as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toEqual(expect.arrayContaining(['agent_cwd']));
        expect(upgraded.projects.get(project.id)).not.toHaveProperty('icon');
        expect(
            (upgraded.database.pragma('table_info(projects)') as Array<{ name: string }>).map(
                ({ name }) => name,
            ),
        ).toEqual(expect.arrayContaining(['icon_name', 'icon_color', 'owner_project_id']));
        /**
         * No row in a pre-existing database can be attributed to an owner, so every Project stays top-level and the
         * PrimarySidebar shows exactly what it showed before the upgrade.
         */
        expect(
            upgraded.database
                .prepare('SELECT id FROM projects WHERE owner_project_id IS NOT NULL')
                .all(),
        ).toEqual([]);
        for (const upgradedProject of upgraded.projects.list())
            expect(upgradedProject).not.toHaveProperty('ownerProjectId');
        expect(upgraded.sessions.get('session-preserved')).toMatchObject({
            lastSessionActivityAt: 1,
            lastSessionActivityReason: 'created',
            attentionEpoch: 0,
            id: 'session-preserved',
            projectId: project.id,
            workbenchProjectId: project.id,
            displayTitle: 'Shell',
            hasUnread: false,
            readAttentionEpoch: 0,
            titleMode: 'automatic',
        });
        expect(upgraded.sessions.get('session-manual')).toMatchObject({
            displayTitle: 'Keep this title',
            titleMode: 'manual',
        });
        expect(upgraded.terminals.get('terminal-preserved')).toMatchObject({
            agentCwd: undefined,
            id: 'terminal-preserved',
            failureReason: undefined,
            lastAgentProcessState: undefined,
            ptyTitle: 'zsh old-project',
            title: 'Shell',
        });
        expect(upgraded.terminals.get('terminal-claude')).toMatchObject({
            lastAgentProcessState: 'stopped',
            ptyTitle: 'claude working',
            title: 'Claude Code',
        });
        expect(upgraded.terminals.get('terminal-codex')).toMatchObject({
            lastAgentProcessState: 'interrupted',
            lastProcessState: 'interrupted',
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

    it('round-trips view state independently for each Session', async () => {
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

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { agentProviderIds } from '@caxri/protocol';
import Database from 'better-sqlite3';
import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { ShutdownReason } from '../session-policy';
import { defaultTerminalTitle, shutdownOutcome } from '../session-policy';
import {
    CURRENT_SCHEMA_VERSION,
    migrationManifest,
    PRESERVED_SCHEMA_VERSION,
    preservingMigrations,
    schemaVersionForMigration,
} from './migrations/manifest';
import * as schema from './schema';
import { terminals } from './schema';

export { CURRENT_SCHEMA_VERSION } from './migrations/manifest';
export { DEFAULT_LAYOUT_VERSION } from './schema';

export type CaxriDrizzleDatabase = BetterSQLite3Database<typeof schema>;

function restrictPath(path: string, mode: number): void {
    try {
        // oxlint-disable-next-line node/no-sync -- better-sqlite3 has no async API; runs on the synchronous open path.
        chmodSync(path, mode);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

const FOREIGN_KEYS_PRAGMA_PATTERN = /\bPRAGMA\s+foreign_keys\b/iu;

/**
 * Migrations run inside one SQLite transaction ({@link initializeSchema}), so `PRAGMA foreign_keys` is a no-op there. A
 * migration that needs to rebuild a table with foreign keys must use create-copy-drop-rename instead of toggling the
 * pragma.
 */
export function assertMigrationSqlOmitsForeignKeysPragma(sql: string): void {
    if (!FOREIGN_KEYS_PRAGMA_PATTERN.test(sql)) return;
    throw new Error(
        'Migration SQL cannot contain PRAGMA foreign_keys; SQLite ignores it inside the migration transaction. Rebuild the table with create-copy-drop-rename instead.',
    );
}

function runGeneratedSql(database: Database.Database, sql: string): void {
    assertMigrationSqlOmitsForeignKeysPragma(sql);
    database.exec(sql.replaceAll('--> statement-breakpoint', ''));
}

function installCurrentSchema(database: Database.Database): void {
    for (const migration of migrationManifest) runGeneratedSql(database, migration.sql);
}

const PROJECT_ORDER_SCHEMA_VERSION = schemaVersionForMigration('0004_wonderful_gladiator');
const TERMINAL_PTY_TITLE_SCHEMA_VERSION = schemaVersionForMigration('0015_terminal-pty-title');
const SESSION_ACTIVITY_SCHEMA_VERSION = schemaVersionForMigration('0017_salty_piledriver');
const SESSION_SIDEBAR_ORDER_SCHEMA_VERSION = schemaVersionForMigration(
    '0023_session-sidebar-order',
);
const AGENT_PROCESS_STATE_SCHEMA_VERSION = schemaVersionForMigration(
    '0018_empty_marten_broadcloak',
);

/**
 * Preserves the v9 PrimarySidebar order, which was defined by `created_at, id`, as explicit indexes.
 */
function backfillProjectOrder(database: Database.Database): void {
    const legacyProjects = database
        .prepare('SELECT id FROM projects ORDER BY created_at, id')
        .all() as Array<{ id: string }>;
    const updateOrder = database.prepare('UPDATE projects SET order_index = ? WHERE id = ?');
    for (const [orderIndex, project] of legacyProjects.entries())
        updateOrder.run(orderIndex, project.id);
}

/**
 * Preserves the PTY-authored display title that schema v19 stored in `title`, then restores the kind-derived stable
 * identity. This data repair lives beside the generated migration runner so `drizzle-kit generate` remains the sole
 * author of schema SQL.
 */
function backfillTerminalTitles(database: Database.Database): void {
    database.prepare('UPDATE terminals SET pty_title = title').run();
    const restoreStableTitle = database.prepare('UPDATE terminals SET title = ? WHERE kind = ?');
    for (const kind of ['shell', ...agentProviderIds] as const)
        restoreStableTitle.run(defaultTerminalTitle(kind), kind);
}

/**
 * Creation is the only historical event whose meaning is known. `last_opened_at` is deliberately excluded: a visit must
 * not become retroactive evidence that work progressed merely because the schema gained Session Activity.
 */
function backfillSessionActivity(database: Database.Database): void {
    database
        .prepare(
            "UPDATE sessions SET last_session_activity_at = created_at, last_session_activity_reason = 'created'",
        )
        .run();
}

/**
 * Before Shell-root Agent Terminals, the Terminal process state also described the directly launched Agent. Preserve
 * that recovery intent for existing Agent records so the first upgraded start can distinguish an interrupted Agent from
 * a Terminal that had already returned to an idle Shell.
 */
function backfillAgentProcessState(database: Database.Database): void {
    database
        .prepare(
            "UPDATE terminals SET last_agent_process_state = last_process_state WHERE kind <> 'shell' OR provider IS NOT NULL",
        )
        .run();
}

function migratePreservingData(database: Database.Database, version: number): void {
    for (const migration of preservingMigrations)
        if (migration.version > version) runGeneratedSql(database, migration.sql);
    if (version < PROJECT_ORDER_SCHEMA_VERSION) backfillProjectOrder(database);
    if (version < TERMINAL_PTY_TITLE_SCHEMA_VERSION) backfillTerminalTitles(database);
    if (version < SESSION_ACTIVITY_SCHEMA_VERSION) backfillSessionActivity(database);
    if (version < AGENT_PROCESS_STATE_SCHEMA_VERSION) backfillAgentProcessState(database);
    if (version < SESSION_SIDEBAR_ORDER_SCHEMA_VERSION)
        database.exec(`
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY project_id ORDER BY last_session_activity_at DESC, created_at DESC, id
                ) - 1 AS position FROM sessions
            )
            UPDATE sessions SET sidebar_order = (SELECT position FROM ranked WHERE ranked.id = sessions.id)
        `);
}

function initializeSchema(database: Database.Database): void {
    const version = database.pragma('user_version', { simple: true }) as number;
    if (version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
            `Database uses newer schema version ${version}; Caxri supports ${CURRENT_SCHEMA_VERSION}`,
        );
    }
    // The entire migration body runs in one transaction. SQLite ignores PRAGMA foreign_keys
    // inside a transaction, and openDatabase already enables foreign keys before this runs.
    database.transaction(() => {
        if (version > 0 && version < PRESERVED_SCHEMA_VERSION) {
            /**
             * Pre-release metadata can be rebuilt; Project folders and user files are never touched.
             */
            database.exec(`
                DROP TABLE IF EXISTS protocol_changefeed;
                DROP TABLE IF EXISTS protocol_command_receipts;
                DROP TABLE IF EXISTS protocol_identity;
                DROP TABLE IF EXISTS agent_delegations;
                DROP TABLE IF EXISTS agent_dispatch_receipts;
                DROP TABLE IF EXISTS mobile_agent_submit_receipts;
                DROP TABLE IF EXISTS terminal_snapshots;
                DROP TABLE IF EXISTS session_state;
                DROP TABLE IF EXISTS terminals;
                DROP TABLE IF EXISTS sessions;
                DROP TABLE IF EXISTS projects;
                DROP TABLE IF EXISTS app_state;
            `);
        }
        if (version === 0 || (version > 0 && version < PRESERVED_SCHEMA_VERSION))
            installCurrentSchema(database);
        else if (version < CURRENT_SCHEMA_VERSION) migratePreservingData(database, version);
        database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    })();
}

/**
 * Bulk-marks Terminals that were still alive as of `reason` (see {@link ShutdownReason}) with the resulting Terminal
 * process state decided by `session-policy.ts`'s {@link shutdownOutcome}. This module owns only the query/update
 * mechanics; which states apply is a domain decision. Exported as `markShutdown` for both the recovery path at
 * {@link openDatabase} (always `unclean`) and `./index.ts`'s `CaxriDatabaseConnection.markShutdown` (orderly/terminate,
 * chosen by the caller).
 */
export function markShutdown(
    database: CaxriDrizzleDatabase,
    now: number,
    reason: ShutdownReason,
): void {
    const { liveProcessStates, terminalProcessState } = shutdownOutcome(reason);
    database
        .update(terminals)
        .set({ lastProcessState: terminalProcessState, updatedAt: now })
        .where(inArray(terminals.lastProcessState, liveProcessStates))
        .run();
    database
        .update(terminals)
        .set({ lastAgentProcessState: terminalProcessState, updatedAt: now })
        .where(inArray(terminals.lastAgentProcessState, liveProcessStates))
        .run();
}

export interface OpenedDatabase {
    /**
     * Raw better-sqlite3 handle; still needed for pragmas and integration tests that inspect
     * `table_info`/`user_version` directly.
     */
    database: Database.Database;
    /**
     * Drizzle query-builder instance bound to the same connection and to `./schema`.
     */
    db: CaxriDrizzleDatabase;
}

/**
 * Opens (creating if needed) the Caxri SQLite database: restricts the owning directory and file to the current user,
 * enables WAL/foreign-keys/busy-timeout, runs schema initialization, and recovers from any unclean previous shutdown.
 */
export function openDatabase(path: string): OpenedDatabase {
    if (path !== ':memory:') {
        // oxlint-disable-next-line node/no-sync -- deliberate startup boundary before the synchronous `Database` open below.
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        /**
         * Electron owns this userData directory, so restricting it also protects adjacent Caxri configuration and logs.
         */
        restrictPath(dirname(path), 0o700);
    }
    const database = new Database(path);
    try {
        if (path !== ':memory:') restrictPath(path, 0o600);
        database.pragma('journal_mode = WAL');
        database.pragma('foreign_keys = ON');
        database.pragma('busy_timeout = 5000');
        /**
         * Explicit, not a change: better-sqlite3 compiles with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, so WAL already runs at
         * NORMAL. Pinning it keeps the Server's event-loop budget (sub-millisecond 2MiB snapshot upserts, measured for
         * issue #237) independent of a future build-flag change; NORMAL under WAL cannot corrupt the database, a power
         * loss merely loses the last transactions.
         */
        database.pragma('synchronous = NORMAL');
        initializeSchema(database);
        const database_ = drizzle(database, { schema });
        markShutdown(database_, Date.now(), 'unclean');
        if (path !== ':memory:') {
            restrictPath(`${path}-wal`, 0o600);
            restrictPath(`${path}-shm`, 0o600);
        }
        return { database, db: database_ };
    } catch (error) {
        database.close();
        throw error;
    }
}

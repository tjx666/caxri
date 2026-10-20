import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './full-schema';
import {
    BASELINE_SCHEMA_VERSION,
    CURRENT_SCHEMA_VERSION,
    migrationManifest,
    migrationsAfterBaseline,
} from './migrations/manifest';
import { terminals } from './schema';
import type { ShutdownReason } from './session-policy';
import { shutdownOutcome } from './session-policy';

export { CURRENT_SCHEMA_VERSION } from './migrations/manifest';

export type CaxriDrizzleDatabase = BetterSQLite3Database<typeof schema>;

function restrictPath(path: string, mode: number): void {
    try {
        // oxlint-disable-next-line node/no-sync -- better-sqlite3 has no async API; runs on the synchronous open path.
        chmodSync(path, mode);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const FOREIGN_KEYS_PRAGMA_PATTERN = /\bPRAGMA\s+foreign_keys\b/iu;
/**
 * The exact standalone statements drizzle-kit's SQLite generator writes before and after every create-copy-drop-rename
 * table rebuild.
 */
const GENERATED_FOREIGN_KEYS_TOGGLES = new Set([
    'PRAGMA foreign_keys=OFF;',
    'PRAGMA foreign_keys=ON;',
]);

/**
 * The one sanctioned authoring path for a migration, table rebuilds included. The persistence architecture reference
 * repeats this sentence verbatim, and a test keeps the two identical.
 */
export const MIGRATION_AUTHORING_RULE =
    'Generate the migration with `bunx --bun drizzle-kit generate` and commit its SQL unchanged, including the standalone `PRAGMA foreign_keys=OFF;` and `PRAGMA foreign_keys=ON;` statements drizzle-kit writes around a table rebuild: the migration runner drops them and owns the foreign-key toggle.';

/**
 * Returns the SQL the runner executes for one generated migration. drizzle-kit's standalone foreign-key toggles are
 * dropped because {@link migrateWithForeignKeysOff} already disables enforcement outside the migration transaction,
 * where SQLite would ignore them anyway. Any other `PRAGMA foreign_keys` is rejected: it cannot take effect inside the
 * transaction, so it would only make a hand-written migration look safer than it runs (issue #746).
 */
export function executableMigrationSql(sql: string): string {
    const executable = sql
        .split(STATEMENT_BREAKPOINT)
        .filter((statement) => !GENERATED_FOREIGN_KEYS_TOGGLES.has(statement.trim()))
        .join('');
    if (FOREIGN_KEYS_PRAGMA_PATTERN.test(executable)) {
        throw new Error(
            `Migration SQL may contain PRAGMA foreign_keys only as the standalone statements drizzle-kit generates around a table rebuild. ${MIGRATION_AUTHORING_RULE}`,
        );
    }
    return executable;
}

function runGeneratedSql(database: Database.Database, sql: string): void {
    database.exec(executableMigrationSql(sql));
}

function installCurrentSchema(database: Database.Database): void {
    for (const migration of migrationManifest) runGeneratedSql(database, migration.sql);
}

interface ForeignKeyViolation {
    /**
     * Child table holding the dangling reference.
     */
    table: string;
    /**
     * Parent table the reference names.
     */
    parent: string;
}

/**
 * Names only the table pairs and counts: the rows themselves are user metadata, which diagnostics never carry.
 */
function foreignKeyViolationSummary(violations: readonly ForeignKeyViolation[]): string {
    const counts = new Map<string, number>();
    for (const { parent, table } of violations) {
        const edge = `${table} -> ${parent}`;
        counts.set(edge, (counts.get(edge) ?? 0) + 1);
    }
    return [...counts].map(([edge, count]) => `${edge} (${count})`).join(', ');
}

/**
 * Runs `migrate` under SQLite's procedure for schema changes ALTER TABLE cannot express
 * (https://www.sqlite.org/lang_altertable.html#otheralter): foreign keys are disabled before the migration transaction
 * opens, because `PRAGMA foreign_keys` is a no-op inside one; `PRAGMA foreign_key_check` must come back empty before
 * the transaction commits; enforcement is re-enabled afterwards whether or not the migration succeeded.
 *
 * With enforcement on, `DROP TABLE` of a parent such as `projects`, `sessions`, or `terminals` performs an implicit
 * `DELETE` that fires `ON DELETE CASCADE` and wipes every child row, including rows a rebuild already copied into its
 * replacement table. The trade-off is that no cascade or `SET NULL` action fires during any migration; the check turns
 * every reference such a migration leaves dangling into a rollback instead of silent corruption.
 */
function migrateWithForeignKeysOff(
    database: Database.Database,
    targetVersion: number,
    migrate: () => void,
): void {
    database.pragma('foreign_keys = OFF');
    try {
        if (database.pragma('foreign_keys', { simple: true }) !== 0)
            throw new Error(
                'Cannot disable foreign keys for the schema migration; it must start outside a transaction',
            );
        database.transaction(() => {
            migrate();
            const violations = database.pragma('foreign_key_check') as ForeignKeyViolation[];
            if (violations.length > 0) {
                throw new Error(
                    `Migration to schema version ${targetVersion} was rolled back: PRAGMA foreign_key_check found ${violations.length} violation(s): ${foreignKeyViolationSummary(violations)}`,
                );
            }
        })();
    } finally {
        database.pragma('foreign_keys = ON');
    }
}

function initializeSchema(database: Database.Database): void {
    const version = database.pragma('user_version', { simple: true }) as number;
    if (version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
            `Database uses newer schema version ${version}; Caxri supports ${CURRENT_SCHEMA_VERSION}`,
        );
    }
    /**
     * Nothing to migrate: skipping keeps the whole-database `foreign_key_check` off the ordinary startup path.
     */
    if (version === CURRENT_SCHEMA_VERSION) return;
    // Every pending step commits atomically or not at all, with foreign keys off; see migrateWithForeignKeysOff.
    migrateWithForeignKeysOff(database, CURRENT_SCHEMA_VERSION, () => {
        if (version > 0 && version < BASELINE_SCHEMA_VERSION) {
            /**
             * Owner-declared clean-install cutoff: pre-baseline development metadata is rebuilt, never upgraded.
             * Project folders and user files are never touched.
             */
            database.exec(`
                DROP TABLE IF EXISTS agent_chat_answered_notices;
                DROP TABLE IF EXISTS agent_chat_process_groups;
                DROP TABLE IF EXISTS benchmark_runs;
                DROP TABLE IF EXISTS commander_inbox_replies;
                DROP TABLE IF EXISTS commander_inbox_items;
                DROP TABLE IF EXISTS commander_pending_notices;
                DROP TABLE IF EXISTS commander_tasks;
                DROP TABLE IF EXISTS agent_session_usage;
                DROP TABLE IF EXISTS external_agent_usage;
                DROP TABLE IF EXISTS pull_request_outcomes;
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
        if (version < BASELINE_SCHEMA_VERSION) installCurrentSchema(database);
        else
            for (const migration of migrationsAfterBaseline)
                if (migration.version > version) runGeneratedSql(database, migration.sql);
        database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    });
}

/**
 * Bulk-marks Terminals that were still alive as of `reason` (see {@link ShutdownReason}) with the resulting Terminal
 * process state decided by `session-policy.ts`'s {@link shutdownOutcome}. This module owns only the query/update
 * mechanics; which states apply is a domain decision. Exported as `markShutdown` for both the recovery path at
 * {@link openDatabase} (always `unclean`) and `./index.ts`'s `CaxriDatabaseConnection.markShutdown` (`orderly`, at
 * Server Core shutdown).
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

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import {
    BASELINE_SCHEMA_VERSION,
    CURRENT_SCHEMA_VERSION,
    migrationManifest,
    migrationsAfterBaseline,
} from './migrations/manifest';
import { backupBeforeRebuild } from './rebuild-backup';
import * as schema from './schema';
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

interface ProcessGroupRow {
    pgid: number;
    terminal_id: string;
    leader_start_token: string;
    recorded_at: number;
}

/**
 * Owner-declared clean-install cutoff: pre-baseline development metadata is rebuilt, never upgraded. Every table goes,
 * including ones a later schema renamed or removed, so nothing of the old shape can collide with the baseline. Project
 * folders and user files are never touched, and `backupBeforeRebuild` kept a copy of the old database beside it.
 *
 * Returns the provider process-group ledger first, plus how many tables were dropped: a Server Core that was killed
 * left those Agent process groups running, and the startup sweep (`reapStaleProviderGroups`) can only stop what the
 * rebuilt ledger still lists.
 */
function dropPreBaselineTables(database: Database.Database): {
    droppedTableCount: number;
    processGroups: ProcessGroupRow[];
} {
    const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .all() as string[];
    const processGroups = tables.includes('agent_chat_process_groups')
        ? readProcessGroups(database)
        : [];
    for (const table of tables) database.exec(`DROP TABLE "${table.replaceAll('"', '""')}"`);
    return { droppedTableCount: tables.length, processGroups };
}

/**
 * Schemas before version 55 name the leader identity `leader_started_at`; later ones name it `leader_start_token`. The
 * column is read by whichever name the rebuilt table has, so a later baseline bump cannot break the carry.
 */
function readProcessGroups(database: Database.Database): ProcessGroupRow[] {
    const columns = database
        .prepare("SELECT name FROM pragma_table_info('agent_chat_process_groups')")
        .pluck()
        .all() as string[];
    const leader = columns.includes('leader_start_token')
        ? 'leader_start_token'
        : 'leader_started_at';
    return database
        .prepare(
            `SELECT pgid, terminal_id, ${leader} AS leader_start_token, recorded_at FROM agent_chat_process_groups`,
        )
        .all() as ProcessGroupRow[];
}

function restoreProcessGroups(database: Database.Database, rows: readonly ProcessGroupRow[]): void {
    const insert = database.prepare(
        'INSERT INTO agent_chat_process_groups (pgid, terminal_id, leader_start_token, recorded_at) VALUES (@pgid, @terminal_id, @leader_start_token, @recorded_at)',
    );
    for (const row of rows) insert.run(row);
}

/**
 * What opening the database did to its schema: `created` for a new file (`user_version` 0), `current` when nothing was
 * pending, `migrated` after running the post-baseline migrations, and `rebuilt` when a pre-baseline database was
 * dropped and reinstalled (see {@link dropPreBaselineTables}).
 */
type DatabaseSchemaOutcome = 'created' | 'current' | 'migrated' | 'rebuilt';

function schemaOutcome(version: number): DatabaseSchemaOutcome {
    if (version === CURRENT_SCHEMA_VERSION) return 'current';
    if (version === 0) return 'created';
    return version < BASELINE_SCHEMA_VERSION ? 'rebuilt' : 'migrated';
}

/**
 * Records the rebuild in the fresh `app_state` table, inside the rebuild transaction, so the record exists exactly when
 * the rebuild committed. Replaces any earlier record (a rebuilt database starts empty, so none survives anyway).
 */
function recordRebuild(
    database: Database.Database,
    rebuild: { at: number; backupPath: string; fromVersion: number },
): void {
    database
        .prepare(
            "INSERT INTO app_state (key, value_json) VALUES ('lastDatabaseRebuild', ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
        )
        .run(JSON.stringify(rebuild));
}

function initializeSchema(database: Database.Database): {
    droppedTableCount: number;
    version: number;
} {
    const version = database.pragma('user_version', { simple: true }) as number;
    if (version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
            `Database uses newer schema version ${version}; Caxri supports ${CURRENT_SCHEMA_VERSION}`,
        );
    }
    /**
     * Nothing to migrate: skipping keeps the whole-database `foreign_key_check` off the ordinary startup path.
     */
    if (version === CURRENT_SCHEMA_VERSION) return { droppedTableCount: 0, version };
    // `VACUUM INTO` cannot run inside the migration transaction, so the copy is taken first.
    const backupPath =
        version > 0 && version < BASELINE_SCHEMA_VERSION && database.name !== ':memory:'
            ? backupBeforeRebuild(database, database.name, version)
            : undefined;
    let droppedTableCount = 0;
    // Every pending step commits atomically or not at all, with foreign keys off; see migrateWithForeignKeysOff.
    migrateWithForeignKeysOff(database, CURRENT_SCHEMA_VERSION, () => {
        const dropped =
            version > 0 && version < BASELINE_SCHEMA_VERSION
                ? dropPreBaselineTables(database)
                : { droppedTableCount: 0, processGroups: [] };
        droppedTableCount = dropped.droppedTableCount;
        if (version < BASELINE_SCHEMA_VERSION) {
            installCurrentSchema(database);
            restoreProcessGroups(database, dropped.processGroups);
            if (backupPath)
                recordRebuild(database, { at: Date.now(), backupPath, fromVersion: version });
        } else
            for (const migration of migrationsAfterBaseline)
                if (migration.version > version) runGeneratedSql(database, migration.sql);
        database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    });
    return { droppedTableCount, version };
}

/**
 * Rows {@link markShutdown} moved out of a live process state: Terminal processes and hosted Agent processes.
 */
export interface ShutdownMarks {
    interruptedAgents: number;
    interruptedTerminals: number;
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
): ShutdownMarks {
    const { liveProcessStates, terminalProcessState } = shutdownOutcome(reason);
    const terminalMarks = database
        .update(terminals)
        .set({ lastProcessState: terminalProcessState, updatedAt: now })
        .where(inArray(terminals.lastProcessState, liveProcessStates))
        .run();
    const agentMarks = database
        .update(terminals)
        .set({ lastAgentProcessState: terminalProcessState, updatedAt: now })
        .where(inArray(terminals.lastAgentProcessState, liveProcessStates))
        .run();
    return { interruptedAgents: agentMarks.changes, interruptedTerminals: terminalMarks.changes };
}

/**
 * Content-free account of one {@link openDatabase}: the schema step and how many live rows the unclean-shutdown recovery
 * rewrote. An orderly shutdown already marked every Terminal `interrupted`, so nonzero counts mean the previous Server
 * Core did not stop cleanly.
 */
export interface DatabaseOpening extends ShutdownMarks {
    /**
     * Tables the clean-install cutoff dropped; 0 unless `outcome` is `rebuilt`.
     */
    droppedTableCount: number;
    durationMs: number;
    fromVersion: number;
    outcome: DatabaseSchemaOutcome;
    toVersion: number;
}

export interface OpenedDatabase {
    /**
     * Raw better-sqlite3 handle; still needed for pragmas and integration tests that inspect
     * `table_info`/`user_version` directly.
     */
    database: Database.Database;
    /**
     * Drizzle query-builder instance bound to the same connection and to `./schema` (every table).
     */
    db: CaxriDrizzleDatabase;
    opening: DatabaseOpening;
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
    const startedAt = performance.now();
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
        const { droppedTableCount, version: fromVersion } = initializeSchema(database);
        const database_ = drizzle(database, { schema });
        const marks = markShutdown(database_, Date.now(), 'unclean');
        if (path !== ':memory:') {
            restrictPath(`${path}-wal`, 0o600);
            restrictPath(`${path}-shm`, 0o600);
        }
        return {
            database,
            db: database_,
            opening: {
                ...marks,
                droppedTableCount,
                durationMs: performance.now() - startedAt,
                fromVersion,
                outcome: schemaOutcome(fromVersion),
                toVersion: CURRENT_SCHEMA_VERSION,
            },
        };
    } catch (error) {
        database.close();
        throw error;
    }
}

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

/**
 * Bumped whenever the DDL below changes shape. Pre-release databases are dropped and rebuilt
 * fresh (see {@link initializeSchema}); there is no migration path yet.
 */
const CURRENT_SCHEMA_VERSION = 5;

/** Shared with `sessions.ts` so the DDL default and the `createSession` insert never drift apart. */
export const DEFAULT_LAYOUT_VERSION = 2;

function restrictPath(path: string, mode: number): void {
    try {
        chmodSync(path, mode);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

function initializeSchema(database: Database.Database): void {
    const version = database.pragma('user_version', { simple: true }) as number;
    if (version > CURRENT_SCHEMA_VERSION) {
        throw new Error(
            `Database uses newer schema version ${version}; Caxri supports ${CURRENT_SCHEMA_VERSION}`,
        );
    }
    database.transaction(() => {
        if (version > 0 && version < CURRENT_SCHEMA_VERSION) {
            /** Pre-release metadata can be rebuilt; Project directories and user files are never touched. */
            database.exec(`
                DROP TABLE IF EXISTS terminal_snapshots;
                DROP TABLE IF EXISTS session_state;
                DROP TABLE IF EXISTS terminals;
                DROP TABLE IF EXISTS sessions;
                DROP TABLE IF EXISTS projects;
                DROP TABLE IF EXISTS app_state;
            `);
        }
        if (version < CURRENT_SCHEMA_VERSION) {
            database.exec(`
                CREATE TABLE projects (
                  id TEXT PRIMARY KEY,
                  root_path TEXT NOT NULL UNIQUE,
                  display_title TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  last_opened_at INTEGER NOT NULL
                );

                CREATE TABLE sessions (
                  id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                  created_at INTEGER NOT NULL,
                  last_opened_at INTEGER NOT NULL,
                  primary_agent_terminal_id TEXT,
                  last_activity_state TEXT NOT NULL DEFAULT 'idle',
                  layout_version INTEGER NOT NULL DEFAULT ${DEFAULT_LAYOUT_VERSION},
                  display_title TEXT NOT NULL
                );

                CREATE TABLE terminals (
                  id TEXT PRIMARY KEY,
                  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                  kind TEXT NOT NULL,
                  provider TEXT,
                  cwd TEXT NOT NULL,
                  title TEXT NOT NULL,
                  icon TEXT NOT NULL,
                  order_index INTEGER NOT NULL,
                  layout_node_id TEXT NOT NULL,
                  agent_session_id TEXT,
                  last_process_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                /** order_index is unique per Session by construction (see terminals.ts); id breaks
                    ties deterministically for any legacy row that predates that guarantee. */
                CREATE INDEX terminals_session_order ON terminals(session_id, order_index, id);
                CREATE INDEX sessions_project_activity ON sessions(project_id, last_opened_at DESC);

                CREATE TABLE terminal_snapshots (
                  terminal_id TEXT PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
                  encoding_version INTEGER NOT NULL,
                  line_count INTEGER NOT NULL,
                  byte_count INTEGER NOT NULL,
                  payload TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );

                /** active_tab_json mirrors open_tabs_json/layout_json: an opaque JSON blob owned by
                    the Renderer/shared layer. The store only serializes and deserializes it and
                    never interprets its shape. */
                CREATE TABLE session_state (
                  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                  open_tabs_json TEXT NOT NULL,
                  active_tab_json TEXT,
                  inspector_mode TEXT NOT NULL,
                  layout_json TEXT NOT NULL
                );

                CREATE TABLE app_state (
                  key TEXT PRIMARY KEY,
                  value_json TEXT NOT NULL
                );
            `);
        }
        database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    })();
}

/** Bulk-marks Terminals that claimed to be alive as `dead` after an unclean Runtime shutdown. */
function markUncleanShutdownDead(database: Database.Database, now: number): void {
    database
        .prepare(
            "UPDATE terminals SET last_process_state = 'dead', updated_at = ? WHERE last_process_state IN ('running', 'starting')",
        )
        .run(now);
    database
        .prepare(
            "UPDATE sessions SET last_activity_state = 'failed' WHERE primary_agent_terminal_id IN (SELECT id FROM terminals WHERE provider IS NOT NULL AND last_process_state = 'dead')",
        )
        .run();
}

/** Bulk-marks running Terminals as `stopped` for an orderly Runtime shutdown. */
export function markAllStopped(database: Database.Database, now: number): void {
    database
        .prepare(
            "UPDATE terminals SET last_process_state = 'stopped', updated_at = ? WHERE last_process_state IN ('running', 'starting')",
        )
        .run(now);
    database
        .prepare(
            "UPDATE sessions SET last_activity_state = 'completed' WHERE primary_agent_terminal_id IN (SELECT id FROM terminals WHERE provider IS NOT NULL AND last_process_state = 'stopped')",
        )
        .run();
}

/**
 * Opens (creating if needed) the Caxri SQLite database: restricts the owning directory and file to
 * the current user, enables WAL/foreign-keys/busy-timeout, runs schema initialization, and recovers
 * from any unclean previous shutdown.
 */
export function openDatabase(path: string): Database.Database {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        /** Electron owns this userData directory, so restricting it also protects adjacent Caxri configuration and logs. */
        restrictPath(dirname(path), 0o700);
    }
    const database = new Database(path);
    try {
        if (path !== ':memory:') restrictPath(path, 0o600);
        database.pragma('journal_mode = WAL');
        database.pragma('foreign_keys = ON');
        database.pragma('busy_timeout = 5000');
        initializeSchema(database);
        markUncleanShutdownDead(database, Date.now());
        if (path !== ':memory:') {
            restrictPath(`${path}-wal`, 0o600);
            restrictPath(`${path}-shm`, 0o600);
        }
        return database;
    } catch (error) {
        database.close();
        throw error;
    }
}

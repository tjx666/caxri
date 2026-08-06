import type Database from 'better-sqlite3';

import { AppStateStore } from './app-state';
import { ProjectsStore } from './projects';
import { SessionsStore } from './sessions';
import { SnapshotsStore } from './snapshots';
import {
    type CaxriDrizzleDatabase,
    markAllStopped as markAllTerminalsStopped,
    openDatabase,
} from './sqlite';
import { TerminalsStore } from './terminals';

export { MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from './terminals';

/**
 * Owns the SQLite connection and composes one pure CRUD module per table family. No domain
 * decision-making lives here; see `../session-policy.ts` for primary-Agent succession, default
 * titles, deletion-fallback selection, and layout edits.
 */
export class CaxriStore {
    /** Raw better-sqlite3 handle; only pragmas, transactions, and integration tests that inspect
        `table_info`/`user_version` touch this directly. Every query goes through {@link db}. */
    readonly database: Database.Database;
    /** Drizzle query-builder instance bound to `./schema`; used by every CRUD module below. */
    readonly db: CaxriDrizzleDatabase;
    readonly projects: ProjectsStore;
    readonly sessions: SessionsStore;
    readonly terminals: TerminalsStore;
    readonly snapshots: SnapshotsStore;
    readonly appState: AppStateStore;

    constructor(path: string) {
        const opened = openDatabase(path);
        this.database = opened.database;
        this.db = opened.db;
        this.projects = new ProjectsStore(this.db);
        this.sessions = new SessionsStore(this.db);
        this.terminals = new TerminalsStore(this.db);
        this.snapshots = new SnapshotsStore(this.db);
        this.appState = new AppStateStore(this.db);
    }

    transaction<T>(work: () => T): T {
        return this.database.transaction(work)();
    }

    markAllStopped(): void {
        this.transaction(() => {
            markAllTerminalsStopped(this.db, Date.now());
        });
    }

    close(): void {
        this.database.close();
    }
}

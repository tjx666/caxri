import type Database from 'better-sqlite3';

import {
    type CaxriDrizzleDatabase,
    markAllStopped as markAllTerminalsStopped,
    openDatabase,
} from './connection';
import { AppStateModel } from './models/app-state';
import { ProjectsModel } from './models/projects';
import { SessionsModel } from './models/sessions';
import { SnapshotsModel } from './models/snapshots';
import { TerminalsModel } from './models/terminals';

export { MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from './models/terminals';
export { CURRENT_SCHEMA_VERSION } from './connection';

/**
 * Owns the SQLite connection and composes one pure CRUD module per table family. No domain
 * decision-making lives here; see `../session-policy.ts` for primary-Agent succession, default
 * titles, deletion-fallback selection, and layout edits.
 */
export class CaxriDb {
    /** Raw better-sqlite3 handle; only pragmas, transactions, and integration tests that inspect
        `table_info`/`user_version` touch this directly. Every query goes through {@link db}. */
    readonly database: Database.Database;
    /** Drizzle query-builder instance bound to `./schema`; used by every CRUD module below. */
    readonly db: CaxriDrizzleDatabase;
    readonly projects: ProjectsModel;
    readonly sessions: SessionsModel;
    readonly terminals: TerminalsModel;
    readonly snapshots: SnapshotsModel;
    readonly appState: AppStateModel;

    constructor(path: string) {
        const opened = openDatabase(path);
        this.database = opened.database;
        this.db = opened.db;
        this.projects = new ProjectsModel(this.db);
        this.sessions = new SessionsModel(this.db);
        this.terminals = new TerminalsModel(this.db);
        this.snapshots = new SnapshotsModel(this.db);
        this.appState = new AppStateModel(this.db);
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

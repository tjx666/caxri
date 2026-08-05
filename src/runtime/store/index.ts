import type Database from 'better-sqlite3';

import { AppStateStore } from './app-state';
import { ProjectsStore } from './projects';
import { SessionsStore } from './sessions';
import { SnapshotsStore } from './snapshots';
import { markAllStopped as markAllTerminalsStopped, openDatabase } from './sqlite';
import { TerminalsStore } from './terminals';

export { CURRENT_SCHEMA_VERSION } from './sqlite';
export { MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from './terminals';

/**
 * Owns the SQLite connection and composes one pure CRUD module per table family. No domain
 * decision-making lives here; see `../session-policy.ts` for primary-Agent succession, default
 * titles, deletion-fallback selection, and layout edits.
 */
export class CaxriStore {
    readonly database: Database.Database;
    readonly projects: ProjectsStore;
    readonly sessions: SessionsStore;
    readonly terminals: TerminalsStore;
    readonly snapshots: SnapshotsStore;
    readonly appState: AppStateStore;

    constructor(path: string) {
        this.database = openDatabase(path);
        this.projects = new ProjectsStore(this.database);
        this.sessions = new SessionsStore(this.database);
        this.terminals = new TerminalsStore(this.database);
        this.snapshots = new SnapshotsStore(this.database);
        this.appState = new AppStateStore(this.database);
    }

    transaction<T>(work: () => T): T {
        return this.database.transaction(work)();
    }

    markAllStopped(): void {
        this.transaction(() => {
            markAllTerminalsStopped(this.database, Date.now());
        });
    }

    close(): void {
        this.database.close();
    }
}

export function createStore(path: string): CaxriStore {
    return new CaxriStore(path);
}

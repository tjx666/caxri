import type Database from 'better-sqlite3';

import type { ShutdownReason } from '../session-policy';
import type { CaxriDrizzleDatabase } from './connection';
import {
    CURRENT_SCHEMA_VERSION,
    markShutdown as markTerminalsShutdown,
    openDatabase,
} from './connection';
import { AgentDispatchReceiptsModel } from './models/agent-dispatch-receipts';
import { AppStateModel } from './models/app-state';
import { ProjectsModel } from './models/projects';
import type { SessionStateRepair } from './models/sessions';
import { SessionsModel } from './models/sessions';
import { SnapshotsModel } from './models/snapshots';
import { TerminalsModel } from './models/terminals';

export interface CaxriDatabaseConnectionOptions {
    onSessionStateRepair?: (repair: SessionStateRepair) => void;
}

/**
 * Owns the SQLite connection and composes one pure CRUD module per table family. No domain decision-making lives here;
 * see `../session-policy.ts` for primary-Agent succession, default titles, deletion-fallback selection, and layout
 * edits.
 */
export class CaxriDatabaseConnection {
    /**
     * Raw better-sqlite3 handle; only pragmas, transactions, and integration tests that inspect
     * `table_info`/`user_version` touch this directly. Every query goes through {@link CaxriDatabaseConnection.db}.
     */
    readonly database: Database.Database;
    /**
     * Drizzle query-builder instance bound to `./schema`; used by every CRUD module below.
     */
    readonly db: CaxriDrizzleDatabase;
    readonly projects: ProjectsModel;
    readonly sessions: SessionsModel;
    readonly terminals: TerminalsModel;
    readonly snapshots: SnapshotsModel;
    readonly appState: AppStateModel;
    readonly agentDispatchReceipts: AgentDispatchReceiptsModel;

    constructor(path: string, options: CaxriDatabaseConnectionOptions = {}) {
        const opened = openDatabase(path);
        this.database = opened.database;
        this.db = opened.db;
        this.projects = new ProjectsModel(this.db);
        this.sessions = new SessionsModel(this.db, options.onSessionStateRepair);
        this.terminals = new TerminalsModel(this.db);
        this.snapshots = new SnapshotsModel(this.db);
        this.appState = new AppStateModel(this.db);
        this.agentDispatchReceipts = new AgentDispatchReceiptsModel(this.db);
        this.appState.set('schemaVersion', CURRENT_SCHEMA_VERSION);
    }

    transaction<T>(work: () => T): T {
        return this.database.transaction(work)();
    }

    markShutdown(reason: ShutdownReason): void {
        this.transaction(() => {
            markTerminalsShutdown(this.db, Date.now(), reason);
        });
    }

    close(): void {
        this.database.close();
    }
}

import type Database from 'better-sqlite3';

import type { CaxriDrizzleDatabase } from './connection';
import { markShutdown as markTerminalsShutdown, openDatabase } from './connection';
import { AgentChatStateModel } from './models/agent-chat-state';
import { AgentDelegationsModel } from './models/agent-delegations';
import { AgentDispatchReceiptsModel } from './models/agent-dispatch-receipts';
import { AgentSessionUsageModel } from './models/agent-session-usage';
import { AppStateModel } from './models/app-state';
import { BotInboxModel } from './models/bot-inbox';
import { BotPendingNoticesModel } from './models/bot-pending-notices';
import { BotTasksModel } from './models/bot-tasks';
import { MobileAgentSubmitReceiptsModel } from './models/mobile-agent-submit-receipts';
import { ProjectsModel } from './models/projects';
import { ProtocolStateModel } from './models/protocol-state';
import type {
    SessionStateRevisionAdvance,
    SessionStateStaleWrite,
} from './models/session-state-revisions';
import type { SessionStateRepair, SessionStateUnchangedWrite } from './models/session-state-row';
import { SessionsModel } from './models/sessions';
import { SnapshotsModel } from './models/snapshots';
import { TerminalsModel } from './models/terminals';
import {
    remapWorkbenchEditorState,
    removeWorkbenchEditorPath,
} from './models/workbench-editor-state';
import type { ShutdownReason } from './session-policy';

export interface CaxriDatabaseConnectionOptions {
    onSessionStateRepair?: (repair: SessionStateRepair) => void;
    onSessionStateUnchanged?: (report: SessionStateUnchangedWrite) => void;
    onSessionStateRevisionAdvanced?: (advance: SessionStateRevisionAdvance) => void;
    onSessionStateStaleWrite?: (staleWrite: SessionStateStaleWrite) => void;
    onTransaction?: (observation: DatabaseTransactionObservation) => void;
}

export interface DatabaseTransactionObservation {
    durationMs: number;
    outcome: 'contention' | 'failure' | 'success';
}

function transactionOutcome(error: unknown): DatabaseTransactionObservation['outcome'] {
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
    return code?.startsWith('SQLITE_BUSY') || code?.startsWith('SQLITE_LOCKED')
        ? 'contention'
        : 'failure';
}

/**
 * Owns the SQLite connection and composes one pure CRUD module per table family. No domain decision-making lives here;
 * see `./session-policy.ts` for primary-Agent succession, default titles, deletion-fallback selection, and layout
 * edits.
 */
export class CaxriDatabaseConnection {
    private readonly onTransaction?: CaxriDatabaseConnectionOptions['onTransaction'];
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
    readonly mobileAgentSubmitReceipts: MobileAgentSubmitReceiptsModel;
    readonly agentDelegations: AgentDelegationsModel;
    readonly agentSessionUsage: AgentSessionUsageModel;
    readonly botInbox: BotInboxModel;
    readonly protocolState: ProtocolStateModel;
    readonly botTasks: BotTasksModel;
    readonly botPendingNotices: BotPendingNoticesModel;
    readonly agentChatState: AgentChatStateModel;

    constructor(path: string, options: CaxriDatabaseConnectionOptions = {}) {
        const opened = openDatabase(path);
        this.database = opened.database;
        this.db = opened.db;
        this.projects = new ProjectsModel(this.db);
        this.sessions = new SessionsModel(
            this.db,
            options.onSessionStateRepair,
            options.onSessionStateUnchanged,
            {
                onRevisionAdvanced: options.onSessionStateRevisionAdvanced,
                onStaleWrite: options.onSessionStateStaleWrite,
            },
        );
        this.agentSessionUsage = new AgentSessionUsageModel(this.db);
        this.terminals = new TerminalsModel(this.db, this.agentSessionUsage);
        this.snapshots = new SnapshotsModel(this.db);
        this.appState = new AppStateModel(this.db);
        this.agentDispatchReceipts = new AgentDispatchReceiptsModel(this.db);
        this.mobileAgentSubmitReceipts = new MobileAgentSubmitReceiptsModel(this.db);
        this.agentDelegations = new AgentDelegationsModel(this.db);
        this.botInbox = new BotInboxModel(this.db, (work) => this.transaction(work));
        this.botTasks = new BotTasksModel(this.db);
        this.botPendingNotices = new BotPendingNoticesModel(this.db);
        this.agentChatState = new AgentChatStateModel(this.database);
        this.protocolState = new ProtocolStateModel(this.db, (work) => this.transaction(work));
        this.onTransaction = options.onTransaction;
    }

    private observeTransaction(observation: DatabaseTransactionObservation): void {
        try {
            this.onTransaction?.(observation);
        } catch {
            // Observability is best-effort and must never alter persistence semantics.
        }
    }

    transaction<T>(work: () => T): T {
        const startedAt = performance.now();
        try {
            const result = this.database.transaction(work)();
            this.observeTransaction({
                durationMs: performance.now() - startedAt,
                outcome: 'success',
            });
            return result;
        } catch (error) {
            this.observeTransaction({
                durationMs: performance.now() - startedAt,
                outcome: transactionOutcome(error),
            });
            throw error;
        }
    }

    /**
     * Durable cross-root editor state spans every Session's `workbenchStateJson`, so it has no single owning CRUD
     * module; both operations run here, inside one transaction, over the whole `session_state` table.
     */
    remapWorkbenchEditorState(
        workbenchProjectId: string,
        operationId: string,
        previousPath: string,
        nextPath: string,
    ): number {
        return this.transaction(() =>
            remapWorkbenchEditorState(
                this.db,
                workbenchProjectId,
                operationId,
                previousPath,
                nextPath,
            ),
        );
    }

    removeWorkbenchEditorPath(workbenchProjectId: string, path: string): number {
        return this.transaction(() => removeWorkbenchEditorPath(this.db, workbenchProjectId, path));
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

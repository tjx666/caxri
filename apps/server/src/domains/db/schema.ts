import type {
    AgentActivityState,
    AgentDelegationReceipt,
    AgentDispatchOperation,
    AgentDispatchStatus,
    ProcessState,
    SessionActivityReason,
    SessionAttentionKind,
    SessionTitleMode,
    TerminalFailureReason,
    UsagePullRequestState,
} from '@caxri/protocol';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import {
    check,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    unique,
    uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const CURRENT_SESSION_STATE_VERSION = 2;

/**
 * Pins a `CHECK` value list to the protocol union it mirrors: omitting a member or naming a foreign one fails type
 * checking, so a widened enum cannot ship until `drizzle-kit generate` has rebuilt the constraint.
 *
 * Open-ended columns (`terminals.kind`, `terminals.provider`, `agent_dispatch_receipts.provider`) deliberately carry no
 * `CHECK`: every new Agent provider would otherwise force a table rebuild for no integrity gain over the model-boundary
 * validation.
 */
function closedValues<T extends string>() {
    return <const V extends readonly T[]>(
        values: V & ([T] extends [V[number]] ? unknown : never),
    ): V => values;
}

/**
 * SQLite evaluates `NULL IN (...)` to NULL, which a `CHECK` accepts, so nullable columns need no extra `IS NULL` arm.
 */
function isOneOf(column: AnySQLiteColumn, values: readonly string[]) {
    return sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;
}

const processStates = closedValues<ProcessState>()([
    'starting',
    'running',
    'stopped',
    'dead',
    'failed',
    'interrupted',
    'suspended',
    'detached',
]);
const terminalFailureReasons = closedValues<TerminalFailureReason>()([
    'working_directory_unavailable',
    'executable_not_found',
    'spawn_failed',
    'agent_session_unavailable',
]);
const agentActivityStates = closedValues<AgentActivityState>()([
    'running',
    'waiting',
    'completed',
    'failed',
    'idle',
    'unknown',
]);
const sessionAttentionKinds = closedValues<SessionAttentionKind>()([
    'waiting',
    'completed',
    'failed',
]);
const sessionActivityReasons = closedValues<SessionActivityReason>()([
    'created',
    'user_submission',
    'agent_started',
    'agent_waiting',
    'agent_completed',
    'agent_failed',
]);
const sessionTitleModes = closedValues<SessionTitleMode>()(['automatic', 'manual']);
const agentDispatchOperations = closedValues<AgentDispatchOperation>()(['start', 'resume', 'wake']);
const agentDispatchStatuses = closedValues<AgentDispatchStatus>()([
    'requested',
    'starting',
    'running',
    'stopped',
    'interrupted',
    'failed',
]);
const pullRequestOutcomeStates = closedValues<UsagePullRequestState>()([
    'open',
    'merged',
    'closed',
    'missing',
]);
const agentDelegationStatuses = closedValues<AgentDelegationReceipt['status']>()([
    'requested',
    'launching',
    'awaiting_ready',
    'submitting',
    'running',
    'collecting',
    'completed',
    'blocked',
    'human_intervened',
    'interrupted',
    'failed',
    'answer_unavailable',
]);
/**
 * Owned by `MobileAgentSubmitReceiptsModel`; there is no protocol union to pin against.
 */
const mobileAgentSubmitStatuses = ['reserved', 'accepted'] as const;

export const projects = sqliteTable(
    'projects',
    {
        id: text('id').primaryKey(),
        rootPath: text('root_path').notNull(),
        displayTitle: text('display_title').notNull(),
        orderIndex: integer('order_index').notNull().default(0),
        createdAt: integer('created_at').notNull(),
        lastOpenedAt: integer('last_opened_at').notNull(),
        iconName: text('icon_name'),
        iconColor: text('icon_color'),
        /**
         * Non-null marks this row as a worktree Caxri auto-registered on behalf of the owning Project: it stays a fully
         * authorized Project, but the PrimarySidebar hides it so linked worktrees never inflate the top-level list.
         * NULL is a root the user added themselves, including a worktree directory they chose to adopt as its own
         * Project. Ownership is one level deep, so deleting the owner cascades to every worktree Project it
         * registered.
         */
        ownerProjectId: text('owner_project_id').references((): AnySQLiteColumn => projects.id, {
            onDelete: 'cascade',
        }),
        /**
         * Non-null while the user has hidden the Project. The row and everything it owns stay intact so a later manual
         * add of the same root restores its Sessions instead of starting an empty Project.
         */
        hiddenAt: integer('hidden_at'),
    },
    (table) => [
        unique().on(table.rootPath),
        index('projects_order').on(table.orderIndex, table.createdAt, table.id),
        index('projects_owner').on(table.ownerProjectId),
    ],
);

export const sessions = sqliteTable(
    'sessions',
    {
        id: text('id').primaryKey(),
        projectId: text('project_id')
            .notNull()
            .references(() => projects.id, { onDelete: 'cascade' }),
        /**
         * Null means "use the owning Project"; a non-null value names an alternate authorized root, such as a linked
         * worktree Project.
         */
        workbenchProjectId: text('workbench_project_id').references(() => projects.id, {
            onDelete: 'set null',
        }),
        /**
         * The mount this root was last seen on. It does not gate access: a device number belongs to the current mount,
         * not to the directory, and macOS re-allocates it on every boot. It is kept as the anchor that makes an
         * ordinary restart observable as `workbench_root.rebound` instead of silent.
         */
        workbenchRootDevice: text('workbench_root_device'),
        /**
         * Captured only for an alternate root so replacement of its pathname fails closed.
         */
        workbenchRootInode: text('workbench_root_inode'),
        createdAt: integer('created_at').notNull(),
        lastOpenedAt: integer('last_opened_at').notNull(),
        /**
         * Product-owned recency for meaningful Session work; every insert supplies a real value.
         */
        lastSessionActivityAt: integer('last_session_activity_at').notNull(),
        /**
         * Explicit sidebar position; dragging must never manufacture Session activity.
         */
        sidebarOrder: integer('sidebar_order').notNull().default(0),
        lastSessionActivityReason: text('last_session_activity_reason')
            .notNull()
            .default('created'),
        archivedAt: integer('archived_at'),
        /**
         * Null means not pinned. Pinning is a durable user choice and deliberately writes neither `sidebar_order` nor
         * the Session Activity clock.
         */
        pinnedAt: integer('pinned_at'),
        /**
         * Explicit position inside the Pinned group. Independent of `sidebar_order`, which keeps ordering the same
         * Session inside its own Project group.
         */
        pinnedOrder: integer('pinned_order').notNull().default(0),
        /**
         * `CaxriDatabase.closeTerminal` elects a successor; `SET NULL` only guarantees that no other deletion path can
         * leave the Session pointing at a Terminal that no longer exists.
         */
        primaryAgentTerminalId: text('primary_agent_terminal_id').references(
            // Sessions and Terminals reference each other; Drizzle resolves this callback lazily after both exist.
            // eslint-disable-next-line no-use-before-define, @typescript-eslint/no-use-before-define
            (): AnySQLiteColumn => terminals.id,
            { onDelete: 'set null' },
        ),
        lastActivityState: text('last_activity_state').notNull().default('idle'),
        attentionEpoch: integer('attention_epoch').notNull().default(0),
        readAttentionEpoch: integer('read_attention_epoch').notNull().default(0),
        lastAttentionKind: text('last_attention_kind'),
        displayTitle: text('display_title').notNull(),
        titleMode: text('title_mode').notNull().default('automatic'),
        automaticNaming: text('automatic_naming', { mode: 'json' }).$type<{
            agentSessionId: string;
            terminalId: string;
            provider: string;
            cwd: string;
            title: string;
            previousTitle?: string;
            status: 'pending' | 'complete' | 'stopped';
            updatedAt: number;
        }>(),
    },
    (table) => [
        /**
         * Matches `SessionsModel.list`'s `created_at, id` order; sidebar and activity ordering are applied in memory.
         */
        index('sessions_project_created').on(table.projectId, table.createdAt, table.id),
        index('sessions_workbench_project').on(table.workbenchProjectId),
        check(
            'sessions_last_activity_state',
            isOneOf(table.lastActivityState, agentActivityStates),
        ),
        check(
            'sessions_last_attention_kind',
            isOneOf(table.lastAttentionKind, sessionAttentionKinds),
        ),
        check(
            'sessions_last_session_activity_reason',
            isOneOf(table.lastSessionActivityReason, sessionActivityReasons),
        ),
        check('sessions_title_mode', isOneOf(table.titleMode, sessionTitleModes)),
    ],
);

export const terminals = sqliteTable(
    'terminals',
    {
        id: text('id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.id, { onDelete: 'cascade' }),
        kind: text('kind').notNull(),
        provider: text('provider'),
        cwd: text('cwd').notNull(),
        /**
         * Where the hosted Agent CLI reports it is currently working, when that diverges from the PTY's launch `cwd`.
         * Claude Code's built-in `EnterWorktree` switches its own session directory and relocates the transcript file
         * to the matching provider directory, while the PTY and this Terminal's authorized launch root are unchanged.
         * Null means "no divergence observed"; a value is written only after Git topology proved the reported path is a
         * linked worktree root of the owning Project's repository, and it is used exclusively to derive the provider's
         * transcript location.
         */
        agentCwd: text('agent_cwd'),
        title: text('title').notNull(),
        ptyTitle: text('pty_title'),
        icon: text('icon').notNull(),
        orderIndex: integer('order_index').notNull(),
        agentSessionId: text('agent_session_id'),
        /**
         * Null until this Shell has hosted an Agent child process. Kept separate from the outer Shell lifecycle below.
         */
        lastAgentProcessState: text('last_agent_process_state'),
        lastProcessState: text('last_process_state').notNull(),
        /**
         * Set only alongside `lastProcessState = 'failed'`; see `TerminalFailureReason`.
         */
        failureReason: text('failure_reason'),
        failureDetail: text('failure_detail'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
        /**
         * Fixed at creation: `pty` for a real pseudo-terminal, `chat` for an Agent Chat driven through the provider's
         * structured protocol (ADR 0012). Chat rows never own a PTY, snapshot, or Shell process. Deliberately left
         * without a `CHECK`: adding one forces drizzle-kit to rebuild `terminals`, and a rebuild would cascade-delete
         * Terminal snapshots and null Primary Agent references. `mapTerminal` treats any value other than `chat` as a
         * PTY.
         */
        surface: text('surface').notNull().default('pty'),
    },
    (table) => [
        /**
         * Inserts append at `MAX(order_index) + 1` and a moved Terminal lands alone in a brand-new Session, so no write
         * ever needs two rows to share a position transiently.
         */
        uniqueIndex('terminals_session_order').on(table.sessionId, table.orderIndex),
        check('terminals_last_process_state', isOneOf(table.lastProcessState, processStates)),
        check(
            'terminals_last_agent_process_state',
            isOneOf(table.lastAgentProcessState, processStates),
        ),
        check('terminals_failure_reason', isOneOf(table.failureReason, terminalFailureReasons)),
        check(
            'terminals_failure_reason_state',
            sql`${table.failureReason} IS NULL OR ${table.lastProcessState} = 'failed'`,
        ),
    ],
);

export const terminalSnapshots = sqliteTable('terminal_snapshots', {
    terminalId: text('terminal_id')
        .primaryKey()
        .references(() => terminals.id, { onDelete: 'cascade' }),
    encodingVersion: integer('encoding_version').notNull(),
    cols: integer('cols').notNull(),
    rows: integer('rows').notNull(),
    lineCount: integer('line_count').notNull(),
    byteCount: integer('byte_count').notNull(),
    payload: text('payload').notNull(),
    updatedAt: integer('updated_at').notNull(),
});

/**
 * Renderer-owned JSON is validated through the shared Session-state schema on every read. `state_version` selects the
 * reader/repair path before any blob is decoded.
 */
export const sessionState = sqliteTable('session_state', {
    sessionId: text('session_id')
        .primaryKey()
        .references(() => sessions.id, { onDelete: 'cascade' }),
    stateVersion: integer('state_version').notNull().default(CURRENT_SESSION_STATE_VERSION),
    /**
     * Optimistic-concurrency token, incremented on every write that actually changes this row. Unrelated to
     * `state_version`, which is the storage-schema version and is identical for every row under one schema. A write
     * whose declared revision no longer matches this column was assembled from a state that has since moved and is
     * rejected rather than applied; see `SessionsModel.updateState`.
     */
    revision: integer('revision').notNull().default(0),
    /**
     * Root-local Workbench snapshots keyed by authorized Project ID. One unified pane tree per Root holds Terminals and
     * documents alike; Terminal processes themselves stay Session-global.
     */
    workbenchStateJson: text('workbench_state_json').notNull().default('{}'),
    desiredSecondarySidebarViewContainerId: text(
        'desired_secondary_sidebar_view_container_id',
    ).notNull(),
});

/**
 * Typed key/value cells validated by `AppStateModel`. `lastSelectedProjectId`, `lastSelectedSessionId`,
 * `externalDelegationSessions`, and `agentCommander` hold row IDs inside JSON, where no foreign key reaches them: every
 * Project or Session deletion path must move the selection (`moveSelectionOffProjects`, `CaxriDatabase.deleteSession`),
 * readers of `externalDelegationSessions` drop bindings whose Session no longer exists, and `agentCommanderRows`
 * verifies every Commander row before trusting it.
 */
export const appState = sqliteTable('app_state', {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull(),
});

/**
 * Durable Agent dispatch receipts fence request retries across Server/Server restarts. Project and Session IDs
 * intentionally are not foreign keys: a receipt remains valid evidence after metadata deletion, while its bounded
 * retention prevents unbounded history growth.
 */
export const agentDispatchReceipts = sqliteTable(
    'agent_dispatch_receipts',
    {
        dispatchId: text('dispatch_id').primaryKey(),
        requestFingerprint: text('request_fingerprint').notNull(),
        operation: text('operation').notNull(),
        status: text('status').notNull(),
        projectId: text('project_id').notNull(),
        sessionId: text('session_id').notNull(),
        terminalId: text('terminal_id'),
        provider: text('provider').notNull(),
        requestedLaunchJson: text('requested_launch_json').notNull(),
        effectiveLaunchJson: text('effective_launch_json').notNull(),
        endpointJson: text('endpoint_json'),
        failureJson: text('failure_json'),
        revision: integer('revision').notNull(),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (table) => [
        index('agent_dispatch_project_updated').on(
            table.projectId,
            table.updatedAt,
            table.dispatchId,
        ),
        index('agent_dispatch_terminal_updated').on(
            table.terminalId,
            table.updatedAt,
            table.dispatchId,
        ),
        check('agent_dispatch_operation', isOneOf(table.operation, agentDispatchOperations)),
        check('agent_dispatch_status', isOneOf(table.status, agentDispatchStatuses)),
    ],
);

/**
 * Reserved before PTY input, so a lost reply or Server restart cannot replay a mobile submission.
 */
export const mobileAgentSubmitReceipts = sqliteTable(
    'mobile_agent_submit_receipts',
    {
        deviceId: text('device_id').notNull(),
        deviceGeneration: integer('device_generation').notNull(),
        clientMutationId: text('client_mutation_id').notNull(),
        requestFingerprint: text('request_fingerprint').notNull(),
        status: text('status').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.deviceId, table.deviceGeneration, table.clientMutationId] }),
        index('mobile_agent_submit_created').on(table.createdAt),
        check('mobile_agent_submit_status', isOneOf(table.status, mobileAgentSubmitStatuses)),
    ],
);

/**
 * One durable identity row anchors recovery across Server boots. `state_epoch` changes only when the compatible
 * changefeed history is deliberately replaced; a normal restart changes the Boot ID, not this row.
 */
export const protocolIdentity = sqliteTable(
    'protocol_identity',
    {
        singleton: integer('singleton').primaryKey(),
        serverId: text('server_id').notNull().unique(),
        stateEpoch: text('state_epoch').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [check('protocol_identity_singleton', sql`${table.singleton} = 1`)],
);

/**
 * Replays a bounded, content-reviewed command reply after the original reply was lost. Parameters are represented only
 * by a SHA-256 fingerprint; source text, Terminal output, prompts, transcripts, credentials, and environment values are
 * never columns in this table.
 */
export const protocolCommandReceipts = sqliteTable(
    'protocol_command_receipts',
    {
        stateEpoch: text('state_epoch').notNull(),
        clientId: text('client_id').notNull(),
        requestId: text('request_id').notNull(),
        requestFingerprint: text('request_fingerprint').notNull(),
        method: text('method').notNull(),
        replyJson: text('reply_json').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.stateEpoch, table.clientId, table.requestId] }),
        index('protocol_command_receipts_created').on(table.createdAt),
    ],
);

/**
 * Bounded content-free structural invalidations. Authoritative state remains in the domain tables; this is a recovery
 * cursor, not an event-sourced copy of Project files or Terminal streams.
 */
export const protocolChangefeed = sqliteTable(
    'protocol_changefeed',
    {
        sequence: integer('sequence').primaryKey({ autoIncrement: true }),
        stateEpoch: text('state_epoch').notNull(),
        eventName: text('event_name').notNull(),
        eventJson: text('event_json').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [index('protocol_changefeed_epoch_sequence').on(table.stateEpoch, table.sequence)],
);

/**
 * Delegation bodies and answers are private domain data, never bootstrap state or command-journal payloads. Session
 * ownership gives deletion an explicit retention boundary without deleting any Project files.
 *
 * `status` and `terminal_id` are query projections of `record_json.receipt`. `terminal_id` intentionally has no foreign
 * key: a `SET NULL` would desynchronize it from the JSON record, and a closed Terminal's ID stays meaningful evidence
 * for the delegation that ran in it.
 */
export const agentDelegations = sqliteTable(
    'agent_delegations',
    {
        id: text('id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.id, { onDelete: 'cascade' }),
        status: text('status').notNull(),
        terminalId: text('terminal_id'),
        recordJson: text('record_json').notNull(),
    },
    (table) => [
        index('agent_delegations_session').on(table.sessionId),
        index('agent_delegations_status').on(table.status),
        index('agent_delegations_terminal').on(table.terminalId),
        check('agent_delegations_status', isOneOf(table.status, agentDelegationStatuses)),
    ],
);

/**
 * Usage ledger: one row per Agent Session ever bound to a Terminal of a Caxri Session. `terminals.agent_session_id`
 * holds only the current binding and is overwritten by `/clear`, provider switches, and Terminal close, so this table
 * is the only durable record of which provider conversations Caxri itself hosted. Rows are appended by
 * `TerminalsModel.updateAgentSessionId` and the usage service's reconciliation pass, never updated by the Agent.
 *
 * `session_id`, `project_id`, and `terminal_id` intentionally carry no foreign key: tokens already spent stay spent
 * after Session, Project, or Terminal metadata is deleted, and the report labels such rows instead of dropping them.
 *
 * `usage_json` caches the parsed, content-free token aggregate (hourly buckets per model, active time, created pull
 * request URLs) so history survives a provider pruning its own transcripts. `source_fingerprint` is the size and mtime
 * of every transcript file that produced it; a mismatch triggers a rescan.
 */
export const agentSessionUsage = sqliteTable(
    'agent_session_usage',
    {
        provider: text('provider').notNull(),
        agentSessionId: text('agent_session_id').notNull(),
        sessionId: text('session_id').notNull(),
        projectId: text('project_id').notNull(),
        terminalId: text('terminal_id').notNull(),
        /**
         * Provider state root (`terminals.agent_cwd ?? terminals.cwd`) at the latest observed binding; locates the
         * transcript after the Terminal is gone.
         */
        cwd: text('cwd').notNull(),
        boundAt: integer('bound_at').notNull(),
        sourceFingerprint: text('source_fingerprint'),
        scannedAt: integer('scanned_at'),
        usageJson: text('usage_json'),
    },
    (table) => [
        primaryKey({ columns: [table.provider, table.agentSessionId] }),
        index('agent_session_usage_session').on(table.sessionId),
    ],
);

/**
 * Last known GitHub outcome of a pull request an Agent created from a Caxri Session. Merged and closed rows are final
 * and never refetched; open rows are refreshed on a bounded schedule by the usage service. Keyed by the canonical
 * `https://github.com/<owner>/<repo>/pull/<number>` URL harvested from the transcript.
 */
export const pullRequestOutcomes = sqliteTable(
    'pull_request_outcomes',
    {
        url: text('url').primaryKey(),
        state: text('state').notNull(),
        title: text('title').notNull(),
        createdAt: integer('created_at'),
        mergedAt: integer('merged_at'),
        additions: integer('additions').notNull().default(0),
        deletions: integer('deletions').notNull().default(0),
        checkedAt: integer('checked_at').notNull(),
    },
    (table) => [
        check('pull_request_outcomes_state', isOneOf(table.state, pullRequestOutcomeStates)),
    ],
);

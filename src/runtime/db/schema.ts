import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Shared with `sessions.ts` so the DDL default and the `createSession` insert never drift apart.
 */
export const DEFAULT_LAYOUT_VERSION = 2;
export const CURRENT_SESSION_STATE_VERSION = 2;

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
    },
    (table) => [
        unique().on(table.rootPath),
        index('projects_order').on(table.orderIndex, table.createdAt, table.id),
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
         * Null is the migration-safe representation of "use the owning Project".
         */
        workbenchProjectId: text('workbench_project_id').references(() => projects.id, {
            onDelete: 'set null',
        }),
        /**
         * Captured only for an alternate root so replacement of its pathname fails closed.
         */
        workbenchRootDevice: text('workbench_root_device'),
        workbenchRootInode: text('workbench_root_inode'),
        createdAt: integer('created_at').notNull(),
        lastOpenedAt: integer('last_opened_at').notNull(),
        archivedAt: integer('archived_at'),
        primaryAgentTerminalId: text('primary_agent_terminal_id'),
        lastActivityState: text('last_activity_state').notNull().default('idle'),
        attentionEpoch: integer('attention_epoch').notNull().default(0),
        readAttentionEpoch: integer('read_attention_epoch').notNull().default(0),
        lastAttentionKind: text('last_attention_kind'),
        layoutVersion: integer('layout_version').notNull().default(DEFAULT_LAYOUT_VERSION),
        displayTitle: text('display_title').notNull(),
        titleMode: text('title_mode').notNull().default('automatic'),
    },
    (table) => [
        index('sessions_project_activity').on(table.projectId, sql`${table.lastOpenedAt} DESC`),
        index('sessions_workbench_project').on(table.workbenchProjectId),
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
        title: text('title').notNull(),
        icon: text('icon').notNull(),
        orderIndex: integer('order_index').notNull(),
        agentSessionId: text('agent_session_id'),
        lastProcessState: text('last_process_state').notNull(),
        /**
         * Set only alongside `lastProcessState = 'failed'`; see `TerminalFailureReason`.
         */
        failureReason: text('failure_reason'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (table) => [
        /**
         * Order_index is unique per Session by construction (see terminals.ts); id breaks ties deterministically for
         * any legacy row that predates that guarantee.
         */
        index('terminals_session_order').on(table.sessionId, table.orderIndex, table.id),
    ],
);

export const terminalSnapshots = sqliteTable('terminal_snapshots', {
    terminalId: text('terminal_id')
        .primaryKey()
        .references(() => terminals.id, { onDelete: 'cascade' }),
    encodingVersion: integer('encoding_version').notNull(),
    /**
     * Pre-grid snapshot encodings remain stored with null geometry and fail closed at the model boundary.
     */
    cols: integer('cols'),
    rows: integer('rows'),
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
     * Root-local Workbench snapshots keyed by authorized Project ID. One unified pane tree per Root holds Terminals and
     * documents alike; Terminal processes themselves stay Session-global.
     */
    workbenchStateJson: text('workbench_state_json').notNull().default('{}'),
    desiredSecondarySidebarViewContainerId: text(
        'desired_secondary_sidebar_view_container_id',
    ).notNull(),
});

export const appState = sqliteTable('app_state', {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull(),
});

/**
 * Durable Agent dispatch receipts fence request retries across Host/Runtime restarts. Project and Session IDs
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
    ],
);

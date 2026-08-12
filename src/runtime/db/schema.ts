import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/** Shared with `sessions.ts` so the DDL default and the `createSession` insert never drift apart. */
export const DEFAULT_LAYOUT_VERSION = 2;
export const CURRENT_SESSION_STATE_VERSION = 1;

export const projects = sqliteTable(
    'projects',
    {
        id: text('id').primaryKey(),
        rootPath: text('root_path').notNull(),
        displayTitle: text('display_title').notNull(),
        orderIndex: integer('order_index').notNull().default(0),
        createdAt: integer('created_at').notNull(),
        lastOpenedAt: integer('last_opened_at').notNull(),
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
        layoutNodeId: text('layout_node_id').notNull(),
        agentSessionId: text('agent_session_id'),
        lastProcessState: text('last_process_state').notNull(),
        /** Set only alongside `lastProcessState = 'failed'`; see `TerminalFailureReason`. */
        failureReason: text('failure_reason'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (table) => [
        /** order_index is unique per Session by construction (see terminals.ts); id breaks
            ties deterministically for any legacy row that predates that guarantee. */
        index('terminals_session_order').on(table.sessionId, table.orderIndex, table.id),
    ],
);

export const terminalSnapshots = sqliteTable('terminal_snapshots', {
    terminalId: text('terminal_id')
        .primaryKey()
        .references(() => terminals.id, { onDelete: 'cascade' }),
    encodingVersion: integer('encoding_version').notNull(),
    lineCount: integer('line_count').notNull(),
    byteCount: integer('byte_count').notNull(),
    payload: text('payload').notNull(),
    updatedAt: integer('updated_at').notNull(),
});

/** Renderer-owned JSON is validated through the shared Session-state schema on every read.
    `state_version` selects the reader/repair path before any blob is decoded. */
export const sessionState = sqliteTable('session_state', {
    sessionId: text('session_id')
        .primaryKey()
        .references(() => sessions.id, { onDelete: 'cascade' }),
    stateVersion: integer('state_version').notNull().default(CURRENT_SESSION_STATE_VERSION),
    openTabsJson: text('open_tabs_json').notNull(),
    activeTabJson: text('active_tab_json'),
    editorRemapOperationId: text('editor_remap_operation_id'),
    inspectorMode: text('inspector_mode').notNull(),
    layoutJson: text('layout_json').notNull(),
});

export const appState = sqliteTable('app_state', {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull(),
});

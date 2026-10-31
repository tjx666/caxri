import type { TerminalSubagentSummary } from '@caxri/protocol';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';
import { terminals } from './core';

/**
 * Agent Chat state that no provider history can rebuild.
 */

/**
 * The `Answered: ...` notices Server Core records when the user answers an Agent question (`agentChatAnsweredNotice`).
 * No provider's history carries them, so a replay after a Server Core restart would otherwise drop them. A row keeps
 * the notice item as JSON plus its anchor: `after_item_id` is the item that preceded it, the position the replay
 * inserts it back at (see `carryAnsweredNotices`). The row is deleted when a replay no longer holds its turn (a rewind
 * past it) and cascades away with the Terminal. Notices carry the user's answer text: private domain data, never
 * logged.
 */
export const agentChatAnsweredNotices = sqliteTable(
    'agent_chat_answered_notices',
    {
        terminalId: text('terminal_id')
            .notNull()
            .references(() => terminals.id, { onDelete: 'cascade' }),
        itemId: text('item_id').notNull(),
        turnId: text('turn_id').notNull(),
        afterItemId: text('after_item_id'),
        itemJson: text('item_json').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.terminalId, table.itemId] }),
        index('agent_chat_answered_notices_terminal').on(table.terminalId, table.createdAt),
    ],
);

/**
 * The process group of each Agent Chat provider child Server Core spawned and has not yet reaped. A SIGKILLed Server
 * Core cannot reap its providers' groups, so the next start reads this table and stops what is left of them (see
 * `reapStaleProviderGroups`). `leader_start_token` is the leader's process start time as `ps` printed it at spawn; with
 * it a reused process group ID is told apart from the original group before anything is signaled. `terminal_id` is
 * context only and carries no foreign key: a row must outlive its Terminal until the group is reaped. Holds no
 * conversation content.
 */
export const agentChatProcessGroups = sqliteTable('agent_chat_process_groups', {
    pgid: integer('pgid').primaryKey(),
    terminalId: text('terminal_id').notNull(),
    leaderStartToken: text('leader_start_token').notNull(),
    recordedAt: integer('recorded_at').notNull(),
});

const subagentStatuses = closedValues<TerminalSubagentSummary['status']>()([
    'running',
    'completed',
    'failed',
    'stopped',
]);

/**
 * The content-free summary of each native subagent a Chat Agent started (`kind: 'agent'` Chat task), so the sidebar can
 * list them after a Server Core restart without starting any provider. One row per Terminal and task, bounded per Chat
 * (`MAX_TERMINAL_SUBAGENT_SUMMARIES`, oldest ended rows dropped first), and cascaded away with the Terminal. A row
 * persisted as `running` is rewritten to `stopped` when Server Core starts, because the provider process that ran it
 * did not survive. `title` is the subagent's short description, never its conversation.
 */
export const agentChatSubagents = sqliteTable(
    'agent_chat_subagents',
    {
        terminalId: text('terminal_id')
            .notNull()
            .references(() => terminals.id, { onDelete: 'cascade' }),
        taskId: text('task_id').notNull(),
        title: text('title').notNull(),
        agentType: text('agent_type'),
        status: text('status').notNull(),
        startedAt: integer('started_at').notNull(),
        endedAt: integer('ended_at'),
    },
    (table) => [
        primaryKey({ columns: [table.terminalId, table.taskId] }),
        index('agent_chat_subagents_terminal').on(table.terminalId, table.startedAt),
        check('agent_chat_subagents_status', isOneOf(table.status, subagentStatuses)),
    ],
);

/**
 * The turns "Edit from here" replaced, kept so the Chat can still show them as an earlier version of the conversation
 * after the provider rewound its own record (Codex `thread/revert` and Grok Build's rewind delete them). A row holds
 * the replaced slice of the projection, from the edited message on, as JSON. `anchor_turn_id` is the last turn the
 * rewind kept, as the rebuilt projection names it (null when the edited message was the conversation's first), and
 * `agent_session_id` is the conversation it belongs to, so a Chat that starts another conversation stops showing it.
 * `parent_version_id` is the version whose content holds the anchor, null while it is the conversation that continues:
 * a later edit further up moves the versions anchored in the turns it replaces under the new version. Turn ids alone
 * cannot say this, since Grok Build names replayed turns by position (`history:N`), which a later branch reuses.
 * Bounded per Chat (`MAX_AGENT_CHAT_VERSIONS`, `MAX_AGENT_CHAT_VERSION_BYTES`, oldest dropped first) and cascaded away
 * with the Terminal. Conversation content: private domain data, never logged. See `docs/agent-chat.md`.
 */
export const agentChatVersions = sqliteTable(
    'agent_chat_versions',
    {
        terminalId: text('terminal_id')
            .notNull()
            .references(() => terminals.id, { onDelete: 'cascade' }),
        id: text('id').notNull(),
        agentSessionId: text('agent_session_id'),
        parentVersionId: text('parent_version_id'),
        anchorTurnId: text('anchor_turn_id'),
        itemsJson: text('items_json').notNull(),
        turnsJson: text('turns_json').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.terminalId, table.id] }),
        index('agent_chat_versions_terminal').on(table.terminalId, table.createdAt),
    ],
);

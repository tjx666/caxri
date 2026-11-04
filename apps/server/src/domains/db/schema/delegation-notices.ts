import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';
import { agentDelegations, terminals } from './core';

/**
 * What a notice tells the Agent that delegated a task: that the task settled, that it asks that Agent a question, that
 * a permission request of it waits for that Agent's decision, or that the user handed the taken-over Session back.
 */
export type DelegationNoticeKind = 'settled' | 'question' | 'approval' | 'handback';

/**
 * Where a notice stands. `unknown` is a notice written to the caller without proof it arrived; it is never sent again.
 */
export type DelegationNoticeState = 'pending' | 'delivered' | 'skipped' | 'unknown';

const noticeKinds = closedValues<DelegationNoticeKind>()([
    'settled',
    'question',
    'approval',
    'handback',
]);
const noticeStates = closedValues<DelegationNoticeState>()([
    'pending',
    'delivered',
    'skipped',
    'unknown',
]);

/**
 * The notices owed to the Agents that delegated tasks, one row per event: a settled task (`id` is `settled:<task>`), an
 * opened question (`question:<question>`), a decidable approval (`approval:<task>:<request>`), or a hand-back
 * (`handback:<grant>`, whose `subject_id` is the grant). The key makes every event notify once, across restarts. A row
 * holds identifiers and closed values only: the text of a notice is built from the task when it is sent, never stored.
 *
 * - `delegation_id` cascades from `agent_delegations`, so pruning a task removes its notices.
 * - `caller_terminal_id` and `caller_launch_id` pin the notice to the exact launch that delegated the task; a notice
 *   never moves to another Agent.
 * - `acknowledged_at` is set when the caller itself read the settled outcome through `wait` or `result`, which makes the
 *   notice redundant. Delivering a notice does not set it.
 */
export const delegationNotices = sqliteTable(
    'delegation_notices',
    {
        id: text('id').primaryKey(),
        delegationId: text('delegation_id')
            .notNull()
            .references(() => agentDelegations.id, { onDelete: 'cascade' }),
        kind: text('kind').notNull(),
        subjectId: text('subject_id'),
        state: text('state').notNull(),
        callerTerminalId: text('caller_terminal_id').notNull(),
        callerLaunchId: text('caller_launch_id').notNull(),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
        acknowledgedAt: integer('acknowledged_at'),
    },
    (table) => [
        index('delegation_notices_delegation').on(table.delegationId),
        index('delegation_notices_caller').on(table.callerTerminalId, table.state),
        check('delegation_notices_kind', isOneOf(table.kind, noticeKinds)),
        check('delegation_notices_state', isOneOf(table.state, noticeStates)),
        check(
            'delegation_notices_subject',
            sql`(${table.kind} = 'settled') = (${table.subjectId} IS NULL)`,
        ),
    ],
);

/**
 * The settlement notices Caxri actually wrote into a delegating Agent's Chat, one row per delivered message: the
 * SHA-256 digest of the exact text and the items it listed (`items_json`: task ID, child Session ID, and a closed
 * event, never text). A Chat recognizes a notice message only by matching this digest on its own Terminal, so a person
 * who types the same words keeps a plain bubble. Unlike `delegation_notices` it does not cascade from the task, so the
 * row keeps a delivered notice recognizable after the task record is pruned; it cascades with the Terminal and is
 * capped per Terminal by the model.
 */
export const delegationNoticeDeliveries = sqliteTable(
    'delegation_notice_deliveries',
    {
        terminalId: text('terminal_id')
            .notNull()
            .references(() => terminals.id, { onDelete: 'cascade' }),
        digest: text('digest').notNull(),
        itemsJson: text('items_json').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.terminalId, table.digest] }),
        index('delegation_notice_deliveries_terminal').on(table.terminalId, table.createdAt),
    ],
);

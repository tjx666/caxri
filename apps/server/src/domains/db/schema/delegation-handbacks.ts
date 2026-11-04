import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';
import { agentDelegations } from './core';

/**
 * Where a hand-back grant stands: `pending` until the delegating Agent's follow-up uses it, then `consumed`, or
 * `invalidated` when something it was pinned to moved first.
 */
export type DelegationHandBackState = 'pending' | 'consumed' | 'invalidated';

const handBackStates = closedValues<DelegationHandBackState>()([
    'pending',
    'consumed',
    'invalidated',
]);

/**
 * The single-use continuation grants the user gives when they hand a taken-over Session back to the Agent that
 * delegated it. A grant lets that Agent's next `--follow-up` of `delegation_id` reuse the child's Terminal and
 * conversation as a new task; it restores nothing on the old task, whose takeover mark stays.
 *
 * Everything the grant was pinned to is stored, so the follow-up can prove none of it moved: the child's launch,
 * provider conversation, finished turn and input epoch, and the delegating Agent's Terminal and launch. Identifiers and
 * numbers only.
 *
 * - `delegation_id` cascades from `agent_delegations`, so pruning a task removes its grants.
 * - At most one grant per task is `pending` (the partial unique index), so a repeated hand-back finds the first.
 * - `consumed_by` names the task that used the grant and is set exactly when the state is `consumed`.
 */
export const delegationHandBacks = sqliteTable(
    'delegation_hand_backs',
    {
        id: text('id').primaryKey(),
        delegationId: text('delegation_id')
            .notNull()
            .references(() => agentDelegations.id, { onDelete: 'cascade' }),
        sessionId: text('session_id').notNull(),
        terminalId: text('terminal_id').notNull(),
        launchId: text('launch_id').notNull(),
        providerSessionId: text('provider_session_id').notNull(),
        turnId: text('turn_id').notNull(),
        inputEpoch: integer('input_epoch').notNull(),
        callerTerminalId: text('caller_terminal_id').notNull(),
        callerLaunchId: text('caller_launch_id').notNull(),
        state: text('state').notNull(),
        consumedBy: text('consumed_by'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull(),
    },
    (table) => [
        index('delegation_hand_backs_session').on(table.sessionId, table.state),
        index('delegation_hand_backs_terminal').on(table.terminalId, table.state),
        uniqueIndex('delegation_hand_backs_pending')
            .on(table.delegationId)
            .where(sql`${table.state} = 'pending'`),
        check('delegation_hand_backs_state', isOneOf(table.state, handBackStates)),
        check(
            'delegation_hand_backs_consumed',
            sql`(${table.state} = 'consumed') = (${table.consumedBy} IS NOT NULL)`,
        ),
    ],
);

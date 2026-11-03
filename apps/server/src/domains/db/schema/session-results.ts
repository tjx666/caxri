import type { DelegationResultSource } from '@caxri/protocol';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';
import { sessions } from './core';

const delegationResultSources = closedValues<DelegationResultSource>()(['authored', 'excerpt']);

/**
 * What a Session another Session created for a delegation or a consult answered, one row per Session: the summary of
 * its latest completed task, overwritten when a later task of the same Session completes. It is a separate table
 * because the Delegated Sessions feed has to outlive two things the receipt cannot: the 1024-record pruning of
 * `agent_delegations` and the Session's archival. Only deleting the Session removes it (`ON DELETE CASCADE`).
 *
 * `summary` is the delegated Agent's own words (its closing `Summary:` line, or the first paragraph of its answer), so
 * it is private domain data like `agent_delegations`: never in bootstrap state, event-journal payloads, or logs.
 * `delegation_id` names the task that produced it with no foreign key, because pruning removes that record on purpose.
 */
export const sessionResults = sqliteTable(
    'session_results',
    {
        sessionId: text('session_id')
            .primaryKey()
            .references(() => sessions.id, { onDelete: 'cascade' }),
        delegationId: text('delegation_id').notNull(),
        summary: text('summary').notNull(),
        summarySource: text('summary_source').notNull(),
        completedAt: integer('completed_at').notNull(),
    },
    (table) => [
        check(
            'session_results_summary_source',
            isOneOf(table.summarySource, delegationResultSources),
        ),
    ],
);

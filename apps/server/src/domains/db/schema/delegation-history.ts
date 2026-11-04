import type {
    AgentDelegationReceipt,
    DelegationHistoryOutcome,
    DelegationResultSource,
    SessionRelation,
} from '@caxri/protocol';
import { desc, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';

const historyOutcomes = closedValues<DelegationHistoryOutcome>()([
    'completed',
    'human_intervened',
    'interrupted',
    'failed',
    'answer_unavailable',
]);
const historyFailures = closedValues<NonNullable<AgentDelegationReceipt['failure']>>()([
    'rate_limited',
    'authentication_failed',
    'output_limit',
    'startup_not_ready',
    'startup_waiting',
    'submission_unconfirmed',
    'provider_failed',
    'permission_required',
    'target_changed',
    'session_changed',
    'human_input',
    'host_reset',
    'result_missing',
    'payload_overflow',
    'launch_failed',
    'hooks_required',
    'correlation_missing',
    'quota_exhausted',
    'caller_stopped',
    'target_not_ready',
    'target_busy',
]);
const edgeRelations = closedValues<SessionRelation>()(['delegated', 'handoff', 'consult']);
const summarySources = closedValues<DelegationResultSource>()(['authored', 'excerpt']);
const usageScopes = closedValues<'main-thread' | 'provider-task'>()([
    'main-thread',
    'provider-task',
]);

/**
 * Who created a Session and how, kept after either Session is deleted so the cost of delegated work stays attributed to
 * the Session that delegated it. One row per Session with a creator relation, written in the transaction that creates
 * the Session (before any task exists) and backfilled by migration `0008` from the live `sessions` rows.
 *
 * It has no foreign keys on purpose, like `agent_session_usage`: `sessions.created_by_session_id` is cleared when the
 * creator is deleted and the Session's own row cascades away, and either would erase the path the Usage roll-up walks
 * (the ledger keeps the spend). Rows hold only IDs and a closed enum; Project and Session deletion never remove them.
 */
export const delegationEdges = sqliteTable(
    'delegation_edges',
    {
        sessionId: text('session_id').primaryKey(),
        parentSessionId: text('parent_session_id').notNull(),
        relation: text('relation').notNull(),
        createdAt: integer('created_at').notNull(),
    },
    (table) => [
        index('delegation_edges_parent').on(table.parentSessionId),
        check('delegation_edges_relation', isOneOf(table.relation, edgeRelations)),
    ],
);

/**
 * One row per settled delegated task: the outcome, a bounded title and summary an Agent can search after a context
 * reset, and the provider counters. It holds no USD (money stays in `agent_session_usage`) and no prompt.
 *
 * No foreign keys: the row must outlive the Session, the task record (pruned at 1024), and the Project. Only the newest
 * 5000 rows by `settled_at` keep `title` and `summary`; older rows are compacted (`compacted_at` set, text cleared) and
 * never deleted. A NULL counter is unknown, never 0. `title` and `summary` are private domain data: they appear only in
 * the authorized caller's command reply, never in logs, events, or diagnostics.
 *
 * `owner_terminal_id` and `owner_principal_hash` reproduce the task ownership rule (`isDelegationOwner`): the exact
 * Terminal and Endpoint generation that created the task. The hash is a SHA-256 of the principal JSON.
 */
export const delegationHistory = sqliteTable(
    'delegation_history',
    {
        delegationId: text('delegation_id').primaryKey(),
        rootDelegationId: text('root_delegation_id').notNull(),
        retryOf: text('retry_of'),
        sessionId: text('session_id').notNull(),
        projectId: text('project_id').notNull(),
        ownerTerminalId: text('owner_terminal_id'),
        ownerPrincipalHash: text('owner_principal_hash'),
        provider: text('provider').notNull(),
        selectionModel: text('selection_model'),
        selectionEffort: text('selection_effort'),
        outcome: text('outcome').notNull(),
        failure: text('failure'),
        title: text('title'),
        summary: text('summary'),
        summarySource: text('summary_source'),
        inputTokens: integer('input_tokens'),
        outputTokens: integer('output_tokens'),
        cacheReadTokens: integer('cache_read_tokens'),
        cacheWriteTokens: integer('cache_write_tokens'),
        reasoningTokens: integer('reasoning_tokens'),
        totalTokens: integer('total_tokens'),
        usageScope: text('usage_scope'),
        createdAt: integer('created_at').notNull(),
        settledAt: integer('settled_at').notNull(),
        compactedAt: integer('compacted_at'),
    },
    (table) => [
        index('delegation_history_owner_created').on(
            table.ownerTerminalId,
            desc(table.createdAt),
            desc(table.delegationId),
        ),
        index('delegation_history_created').on(desc(table.createdAt), desc(table.delegationId)),
        index('delegation_history_settled').on(desc(table.settledAt), desc(table.delegationId)),
        check('delegation_history_outcome', isOneOf(table.outcome, historyOutcomes)),
        check('delegation_history_failure', isOneOf(table.failure, historyFailures)),
        check('delegation_history_summary_source', isOneOf(table.summarySource, summarySources)),
        check('delegation_history_usage_scope', isOneOf(table.usageScope, usageScopes)),
        check(
            'delegation_history_outcome_failure',
            sql`${table.outcome} <> 'completed' OR ${table.failure} IS NULL`,
        ),
        check(
            'delegation_history_summary_pair',
            sql`(${table.summary} IS NULL) = (${table.summarySource} IS NULL)`,
        ),
        check(
            'delegation_history_summary_completed',
            sql`${table.summary} IS NULL OR ${table.outcome} = 'completed'`,
        ),
        check(
            'delegation_history_compacted_text',
            sql`${table.compactedAt} IS NULL OR (${table.title} IS NULL AND ${table.summary} IS NULL)`,
        ),
        check('delegation_history_settle_order', sql`${table.settledAt} >= ${table.createdAt}`),
        check(
            'delegation_history_scope_counters',
            sql`${table.usageScope} IS NULL OR ${table.inputTokens} IS NOT NULL OR ${table.outputTokens} IS NOT NULL`,
        ),
        check(
            'delegation_history_tokens',
            sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0) AND (${table.cacheReadTokens} IS NULL OR ${table.cacheReadTokens} >= 0) AND (${table.cacheWriteTokens} IS NULL OR ${table.cacheWriteTokens} >= 0) AND (${table.reasoningTokens} IS NULL OR ${table.reasoningTokens} >= 0) AND (${table.totalTokens} IS NULL OR ${table.totalTokens} >= 0)`,
        ),
    ],
);

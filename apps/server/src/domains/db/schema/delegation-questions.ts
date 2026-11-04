import type {
    DelegationQuestionAnsweredBy,
    DelegationQuestionCancelReason,
    DelegationQuestionEscalationReason,
    DelegationQuestionState,
} from '@caxri/protocol';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { closedValues, isOneOf } from './constraints';
import { agentDelegations, sessions } from './core';

const questionStates = closedValues<DelegationQuestionState>()(['open', 'answered', 'cancelled']);
const questionAnsweredBy = closedValues<DelegationQuestionAnsweredBy>()(['parent', 'user']);
const questionCancelReasons = closedValues<DelegationQuestionCancelReason>()([
    'child_cancelled',
    'taken_over',
    'host_reset',
    'task_ended',
]);
const questionEscalationReasons = closedValues<DelegationQuestionEscalationReason>()([
    'grace_elapsed',
    'parent_gone',
]);

/**
 * The questions a delegated Agent asks the Agent that delegated it, one row per question, at most one open per
 * delegation. The text of a question and of its answer is private domain data like `agent_delegations`: it appears only
 * in command replies and owner reads, never in bootstrap state, event-journal payloads, feed entries, or logs.
 *
 * - `delegation_id` cascades from `agent_delegations`, so pruning a delegation removes its questions, and `session_id`
 *   (the child Session) cascades from `sessions`, so deleting the Session does too.
 * - `child_launch_id` and `child_generation` bind the question to the exact asking launch and Endpoint generation. A
 *   restarted Agent in the same Terminal is another launch and can neither wait on nor cancel the question, so it
 *   cannot read an old answer.
 * - `escalated_at` is set while the question is `open`, once it became the user's to answer; the question stays open.
 */
export const delegationQuestions = sqliteTable(
    'delegation_questions',
    {
        id: text('id').primaryKey(),
        delegationId: text('delegation_id')
            .notNull()
            .references(() => agentDelegations.id, { onDelete: 'cascade' }),
        sessionId: text('session_id')
            .notNull()
            .references(() => sessions.id, { onDelete: 'cascade' }),
        childLaunchId: text('child_launch_id').notNull(),
        childGeneration: integer('child_generation').notNull(),
        requestId: text('request_id'),
        questionText: text('question_text').notNull(),
        optionsJson: text('options_json'),
        state: text('state').notNull(),
        answeredBy: text('answered_by'),
        answerText: text('answer_text'),
        cancelReason: text('cancel_reason'),
        askedAt: integer('asked_at').notNull(),
        escalatedAt: integer('escalated_at'),
        escalationReason: text('escalation_reason'),
        closedAt: integer('closed_at'),
    },
    (table) => [
        index('delegation_questions_delegation').on(table.delegationId),
        uniqueIndex('delegation_questions_open_key')
            .on(table.delegationId)
            .where(sql`${table.state} = 'open'`),
        check('delegation_questions_state', isOneOf(table.state, questionStates)),
        check('delegation_questions_answered_by', isOneOf(table.answeredBy, questionAnsweredBy)),
        check(
            'delegation_questions_cancel_reason',
            isOneOf(table.cancelReason, questionCancelReasons),
        ),
        check(
            'delegation_questions_escalation_reason',
            isOneOf(table.escalationReason, questionEscalationReasons),
        ),
        /**
         * Closing writes the outcome and the time together, so no writer stores a half state.
         */
        check(
            'delegation_questions_closed_state',
            sql`(${table.state} = 'open' AND ${table.answeredBy} IS NULL AND ${table.cancelReason} IS NULL AND ${table.closedAt} IS NULL) OR (${table.state} = 'answered' AND ${table.answeredBy} IS NOT NULL AND ${table.answerText} IS NOT NULL AND ${table.cancelReason} IS NULL AND ${table.closedAt} IS NOT NULL) OR (${table.state} = 'cancelled' AND ${table.cancelReason} IS NOT NULL AND ${table.answeredBy} IS NULL AND ${table.closedAt} IS NOT NULL)`,
        ),
        check(
            'delegation_questions_escalation',
            sql`(${table.escalatedAt} IS NULL) = (${table.escalationReason} IS NULL)`,
        ),
    ],
);

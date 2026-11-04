import type {
    DelegationQuestionAnsweredBy,
    DelegationQuestionCancelReason,
    DelegationQuestionEscalationReason,
    DelegationQuestionState,
} from '@caxri/protocol';
import {
    delegationQuestionAnsweredBySchema,
    delegationQuestionCancelReasonSchema,
    delegationQuestionEscalationReasonSchema,
    delegationQuestionStateSchema,
} from '@caxri/protocol';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { delegationQuestions } from '../schema';

/**
 * A question a delegated Agent asked, as stored; see `delegationQuestions`. The text of the question and of its answer
 * is private: the domain that reads this row decides what leaves the Server.
 */
export interface StoredDelegationQuestion {
    id: string;
    delegationId: string;
    /**
     * The child Session that asked.
     */
    sessionId: string;
    /**
     * The asking launch and Endpoint generation; only that Agent may wait on or cancel the question.
     */
    childLaunchId: string;
    childGeneration: number;
    requestId?: string;
    text: string;
    options?: string[];
    state: DelegationQuestionState;
    answeredBy?: DelegationQuestionAnsweredBy;
    answerText?: string;
    cancelReason?: DelegationQuestionCancelReason;
    askedAt: number;
    escalatedAt?: number;
    escalationReason?: DelegationQuestionEscalationReason;
    closedAt?: number;
}

/**
 * Where a question that just closed lives, so the caller can emit its event.
 */
export interface ClosedDelegationQuestion {
    id: string;
    delegationId: string;
    sessionId: string;
}

const optionsSchema = z.array(z.string());

function toStored(row: typeof delegationQuestions.$inferSelect): StoredDelegationQuestion {
    return {
        id: row.id,
        delegationId: row.delegationId,
        sessionId: row.sessionId,
        childLaunchId: row.childLaunchId,
        childGeneration: row.childGeneration,
        ...(row.requestId !== null && { requestId: row.requestId }),
        text: row.questionText,
        ...(row.optionsJson !== null && {
            options: optionsSchema.parse(JSON.parse(row.optionsJson)),
        }),
        state: delegationQuestionStateSchema.parse(row.state),
        ...(row.answeredBy !== null && {
            answeredBy: delegationQuestionAnsweredBySchema.parse(row.answeredBy),
        }),
        ...(row.answerText !== null && { answerText: row.answerText }),
        ...(row.cancelReason !== null && {
            cancelReason: delegationQuestionCancelReasonSchema.parse(row.cancelReason),
        }),
        askedAt: row.askedAt,
        ...(row.escalatedAt !== null && { escalatedAt: row.escalatedAt }),
        ...(row.escalationReason !== null && {
            escalationReason: delegationQuestionEscalationReasonSchema.parse(row.escalationReason),
        }),
        ...(row.closedAt !== null && { closedAt: row.closedAt }),
    };
}

const closedColumns = {
    id: delegationQuestions.id,
    delegationId: delegationQuestions.delegationId,
    sessionId: delegationQuestions.sessionId,
};

/**
 * Pure persistence for the questions delegated Agents ask. It never logs and never decides: the state machine, the
 * authorization, and the events live in the delegation domain. Every transition is one conditional `UPDATE`, so two
 * writers racing for the same open question cannot both win.
 */
export class DelegationQuestionsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Stores a new open question. Throws when the delegation already has one open (the partial unique index).
     */
    insert(question: {
        id: string;
        delegationId: string;
        sessionId: string;
        childLaunchId: string;
        childGeneration: number;
        requestId?: string;
        text: string;
        options?: readonly string[];
        askedAt: number;
    }): StoredDelegationQuestion {
        const row = this.database
            .insert(delegationQuestions)
            .values({
                id: question.id,
                delegationId: question.delegationId,
                sessionId: question.sessionId,
                childLaunchId: question.childLaunchId,
                childGeneration: question.childGeneration,
                requestId: question.requestId ?? null,
                questionText: question.text,
                optionsJson: question.options?.length ? JSON.stringify(question.options) : null,
                state: 'open',
                askedAt: question.askedAt,
            })
            .returning()
            .get();
        return toStored(row);
    }

    get(id: string): StoredDelegationQuestion | undefined {
        const row = this.database
            .select()
            .from(delegationQuestions)
            .where(eq(delegationQuestions.id, id))
            .get();
        return row && toStored(row);
    }

    /**
     * The delegation's question a retried `ask` with the same request ID created, in any state.
     */
    getByRequestId(delegationId: string, requestId: string): StoredDelegationQuestion | undefined {
        const row = this.database
            .select()
            .from(delegationQuestions)
            .where(
                and(
                    eq(delegationQuestions.delegationId, delegationId),
                    eq(delegationQuestions.requestId, requestId),
                ),
            )
            .get();
        return row && toStored(row);
    }

    openForDelegation(delegationId: string): StoredDelegationQuestion | undefined {
        return this.openForDelegations([delegationId]).get(delegationId);
    }

    /**
     * The open question of each named delegation; a delegation with none is absent.
     */
    openForDelegations(delegationIds: readonly string[]): Map<string, StoredDelegationQuestion> {
        const open = new Map<string, StoredDelegationQuestion>();
        if (delegationIds.length === 0) return open;
        const rows = this.database
            .select()
            .from(delegationQuestions)
            .where(
                and(
                    inArray(delegationQuestions.delegationId, [...delegationIds]),
                    eq(delegationQuestions.state, 'open'),
                ),
            )
            .all();
        for (const row of rows) open.set(row.delegationId, toStored(row));
        return open;
    }

    /**
     * How many questions the delegation ever stored, whatever their state.
     */
    countForDelegation(delegationId: string): number {
        return this.database
            .select({ value: count() })
            .from(delegationQuestions)
            .where(eq(delegationQuestions.delegationId, delegationId))
            .get()!.value;
    }

    /**
     * Records the answer if the question is still open. The first writer wins; a loser gets `false` and re-reads the
     * row to learn whether it was answered or cancelled.
     */
    tryAnswer(id: string, by: DelegationQuestionAnsweredBy, text: string, now: number): boolean {
        return (
            this.database
                .update(delegationQuestions)
                .set({ state: 'answered', answeredBy: by, answerText: text, closedAt: now })
                .where(and(eq(delegationQuestions.id, id), eq(delegationQuestions.state, 'open')))
                .run().changes === 1
        );
    }

    /**
     * Closes the question without an answer if it is still open; `false` when it already closed.
     */
    cancel(id: string, reason: DelegationQuestionCancelReason, now: number): boolean {
        return (
            this.database
                .update(delegationQuestions)
                .set({ state: 'cancelled', cancelReason: reason, closedAt: now })
                .where(and(eq(delegationQuestions.id, id), eq(delegationQuestions.state, 'open')))
                .run().changes === 1
        );
    }

    /**
     * Closes the open question of each named delegation, and returns the ones that actually closed.
     */
    cancelOpenForDelegations(
        delegationIds: readonly string[],
        reason: DelegationQuestionCancelReason,
        now: number,
    ): ClosedDelegationQuestion[] {
        if (delegationIds.length === 0) return [];
        return this.database
            .update(delegationQuestions)
            .set({ state: 'cancelled', cancelReason: reason, closedAt: now })
            .where(
                and(
                    inArray(delegationQuestions.delegationId, [...delegationIds]),
                    eq(delegationQuestions.state, 'open'),
                ),
            )
            .returning(closedColumns)
            .all();
    }

    /**
     * Closes every open question, for a Server Core restart that dropped every asking Agent's wait.
     */
    cancelAllOpen(reason: DelegationQuestionCancelReason, now: number): ClosedDelegationQuestion[] {
        return this.database
            .update(delegationQuestions)
            .set({ state: 'cancelled', cancelReason: reason, closedAt: now })
            .where(eq(delegationQuestions.state, 'open'))
            .returning(closedColumns)
            .all();
    }

    /**
     * Marks the open question as the user's to answer, once. `false` when it already closed or already escalated.
     */
    markEscalated(id: string, reason: DelegationQuestionEscalationReason, now: number): boolean {
        return (
            this.database
                .update(delegationQuestions)
                .set({ escalatedAt: now, escalationReason: reason })
                .where(
                    and(
                        eq(delegationQuestions.id, id),
                        eq(delegationQuestions.state, 'open'),
                        isNull(delegationQuestions.escalatedAt),
                    ),
                )
                .run().changes === 1
        );
    }
}

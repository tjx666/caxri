import { randomUUID } from 'node:crypto';

import type {
    DelegationQuestionAnsweredBy,
    DelegationQuestionAskResult,
    DelegationQuestionCancelReason,
    DelegationQuestionChanged,
    DelegationQuestionEscalationReason,
} from '@caxri/protocol';
import { CaxriError, logEventCatalog, MAX_QUESTIONS_PER_DELEGATION } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { DelegationQuestionsModel, StoredDelegationQuestion } from '../../db';

/**
 * What the store needs from the rest of the Server.
 */
export interface DelegationQuestionStoreOptions {
    model: DelegationQuestionsModel;
    now(): number;
    logger?: StructuredLogger;
    /**
     * Called after a question opened, escalated, or closed. The payload is identifiers and closed values only.
     */
    onChanged?(change: DelegationQuestionChanged): void;
}

/**
 * Who asked: the child Session and the exact Agent launch and Endpoint generation in it.
 */
export interface QuestionAsker {
    delegationId: string;
    sessionId: string;
    childLaunchId: string;
    childGeneration: number;
}

/**
 * The state machine of the questions delegated Agents ask. Every transition is one conditional write in the model, so
 * two writers racing for an open question cannot both win; this class adds the event and the log line to each
 * transition that happened. Logs and events carry identifiers, closed enums, and durations, never question or answer
 * text.
 */
export class DelegationQuestionStore {
    constructor(private readonly options: DelegationQuestionStoreOptions) {}

    private logCancelled(
        question: StoredDelegationQuestion,
        reason: DelegationQuestionCancelReason,
        now: number,
    ): void {
        this.options.logger?.write('info', logEventCatalog.agentDelegation.questionCancelled, {
            fields: {
                delegationId: question.delegationId,
                questionId: question.id,
                cancelReason: reason,
                latencyMs: now - question.askedAt,
            },
        });
    }

    private changed(
        question: StoredDelegationQuestion,
        state: DelegationQuestionChanged['state'],
        isEscalated: boolean,
    ): void {
        this.options.onChanged?.({
            sessionId: question.sessionId,
            delegationId: question.delegationId,
            questionId: question.id,
            state,
            escalated: isEscalated,
        });
    }

    get(id: string): StoredDelegationQuestion | undefined {
        return this.options.model.get(id);
    }

    openFor(delegationId: string): StoredDelegationQuestion | undefined {
        return this.options.model.openForDelegation(delegationId);
    }

    openForMany(delegationIds: readonly string[]): Map<string, StoredDelegationQuestion> {
        return this.options.model.openForDelegations(delegationIds);
    }

    /**
     * Opens a question. A replayed request ID returns the original question whatever its state; otherwise an open
     * question of the delegation is left as it is (`already_open`). Throws `CAPACITY` once the delegation stored
     * {@link MAX_QUESTIONS_PER_DELEGATION}.
     */
    ask(
        asker: QuestionAsker,
        input: { text: string; options?: readonly string[]; requestId?: string },
    ): { result: DelegationQuestionAskResult; opened?: StoredDelegationQuestion } {
        const { model } = this.options;
        const replay = input.requestId && model.getByRequestId(asker.delegationId, input.requestId);
        if (replay)
            return {
                result: { outcome: 'asked', questionId: replay.id, askedAt: replay.askedAt },
            };
        const open = model.openForDelegation(asker.delegationId);
        if (open)
            return {
                result: { outcome: 'already_open', questionId: open.id, askedAt: open.askedAt },
            };
        if (model.countForDelegation(asker.delegationId) >= MAX_QUESTIONS_PER_DELEGATION)
            throw new CaxriError('CAPACITY', 'Delegation already asked its limit of questions');
        const opened = model.insert({
            id: randomUUID(),
            ...asker,
            ...input,
            askedAt: this.options.now(),
        });
        this.options.logger?.write('info', logEventCatalog.agentDelegation.questionAsked, {
            fields: {
                delegationId: opened.delegationId,
                questionId: opened.id,
                optionCount: opened.options?.length ?? 0,
            },
        });
        this.changed(opened, 'open', false);
        return {
            result: { outcome: 'asked', questionId: opened.id, askedAt: opened.askedAt },
            opened,
        };
    }

    /**
     * Records an answer if the question is still open. The first writer wins; a loser learns whether the question was
     * answered or cancelled first.
     */
    answer(
        question: StoredDelegationQuestion,
        by: DelegationQuestionAnsweredBy,
        text: string,
    ): 'answered' | 'already_answered' | 'cancelled' {
        const now = this.options.now();
        if (this.options.model.tryAnswer(question.id, by, text, now)) {
            this.options.logger?.write('info', logEventCatalog.agentDelegation.questionAnswered, {
                fields: {
                    delegationId: question.delegationId,
                    questionId: question.id,
                    answeredBy: by,
                    latencyMs: now - question.askedAt,
                },
            });
            this.changed(question, 'answered', question.escalatedAt !== undefined);
            return 'answered';
        }
        return this.options.model.get(question.id)?.state === 'answered'
            ? 'already_answered'
            : 'cancelled';
    }

    /**
     * Closes one open question; `false` when it already closed.
     */
    cancel(question: StoredDelegationQuestion, reason: DelegationQuestionCancelReason): boolean {
        const now = this.options.now();
        if (!this.options.model.cancel(question.id, reason, now)) return false;
        this.logCancelled(question, reason, now);
        this.changed(question, 'cancelled', question.escalatedAt !== undefined);
        return true;
    }

    /**
     * Closes the open question of each named delegation, for a task that ended or whose Agent was taken over.
     */
    cancelForDelegations(
        delegationIds: readonly string[],
        reason: DelegationQuestionCancelReason,
    ): void {
        const open = this.options.model.openForDelegations(delegationIds);
        if (open.size === 0) return;
        for (const question of open.values()) this.cancel(question, reason);
    }

    /**
     * Closes every open question: a Server Core restart dropped every asking Agent's wait. Emits no event, like the
     * recovery of active tasks: it runs while Server Core starts, before the event journal opens, and a Client reloads
     * its state when it connects.
     */
    cancelAll(reason: DelegationQuestionCancelReason): void {
        const now = this.options.now();
        for (const closed of this.options.model.cancelAllOpen(reason, now)) {
            this.options.logger?.write('info', logEventCatalog.agentDelegation.questionCancelled, {
                fields: {
                    delegationId: closed.delegationId,
                    questionId: closed.id,
                    cancelReason: reason,
                },
            });
        }
    }

    /**
     * Makes an open question the user's to answer, once. It never answers or cancels it.
     */
    escalate(questionId: string, reason: DelegationQuestionEscalationReason): void {
        const question = this.options.model.get(questionId);
        const now = this.options.now();
        if (
            question?.state !== 'open' ||
            !this.options.model.markEscalated(questionId, reason, now)
        )
            return;
        this.options.logger?.write('warn', logEventCatalog.agentDelegation.questionEscalated, {
            fields: {
                delegationId: question.delegationId,
                questionId,
                escalationReason: reason,
                latencyMs: now - question.askedAt,
            },
        });
        this.changed(question, 'open', true);
    }
}

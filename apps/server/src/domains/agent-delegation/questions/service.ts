import type {
    DelegationQuestionAnswerResult,
    DelegationQuestionAskResult,
    DelegationQuestionCancelReason,
    DelegationQuestionCancelResult,
    DelegationQuestionDetailResult,
    DelegationQuestionEntry,
    DelegationQuestionsResult,
    DelegationQuestionWaitResult,
} from '@caxri/protocol';
import { CaxriError, MAX_LISTED_QUESTIONS } from '@caxri/protocol';

import type { StoredAgentDelegation, StoredDelegationQuestion } from '../../db';
import type { DelegationAccess, DelegationAuthority } from '../admission';
import { listOwnedDelegations } from '../ownership';
import type { ParentPresence } from '../parent-presence';
import type { AgentDelegationServiceOptions } from '../service-options';
import { QuestionEscalations } from './escalation';
import { DelegationQuestionStore } from './store';
import { MAX_QUESTION_WAITERS, pollQuestion } from './wait';

/**
 * What the questions facade borrows from the delegation service.
 */
export interface DelegationQuestionsHost {
    options: Pick<
        AgentDelegationServiceOptions,
        'database' | 'logger' | 'onQuestionChanged' | 'currentLaunchId'
    >;
    now(): number;
    isClosed(): boolean;
    presence: ParentPresence;
    activeForTerminal(terminalId: string): StoredAgentDelegation | undefined;
    owned(
        id: string,
        authority: DelegationAuthority,
        access: DelegationAccess,
    ): StoredAgentDelegation;
}

function unavailable(): CaxriError {
    return new CaxriError('NOT_FOUND', 'Question is unavailable');
}

/**
 * The questions a delegated Agent asks the Agent that delegated it, and the answers that come back. One question is
 * open per delegation; the first answer wins, whether it comes from the delegating Agent or from the user. See
 * `docs/agent-delegation.md`.
 */
export class DelegationQuestions {
    private readonly store: DelegationQuestionStore;
    private readonly escalations: QuestionEscalations;
    private waiterCount = 0;

    constructor(private readonly host: DelegationQuestionsHost) {
        const { options } = host;
        this.store = new DelegationQuestionStore({
            model: options.database.agentDelegations.questions,
            now: () => host.now(),
            logger: options.logger,
            onChanged: (change) => options.onQuestionChanged?.(change),
        });
        this.escalations = new QuestionEscalations((id, reason) => {
            this.store.escalate(id, reason);
        });
    }

    /**
     * The question as its asking Agent may read it: the delegation must be a task of the caller's Terminal, bound to
     * the same launch and Endpoint generation that asked, and that launch must still be the live one when one is
     * known.
     */
    private askedBy(authority: DelegationAuthority, questionId: string): StoredDelegationQuestion {
        const { principal, callerTerminalId } = authority;
        if (!callerTerminalId || principal.kind !== 'agent') throw unavailable();
        const question = this.store.get(questionId);
        if (!question || question.childGeneration !== principal.generation) throw unavailable();
        const task = this.host.options.database.agentDelegations
            .forTerminal(callerTerminalId)
            .find((candidate) => candidate.receipt.delegationId === question.delegationId);
        if (task?.launchId !== question.childLaunchId) throw unavailable();
        const live = this.host.options.currentLaunchId?.(callerTerminalId);
        if (live !== undefined && live !== question.childLaunchId) throw unavailable();
        return question;
    }

    private cancel(question: StoredDelegationQuestion, reason: DelegationQuestionCancelReason) {
        this.escalations.disarm(question.id);
        return this.store.cancel(question, reason);
    }

    /**
     * The question named by an answer, which must belong to the named delegation.
     */
    private forDelegation(delegationId: string, questionId: string): StoredDelegationQuestion {
        const question = this.store.get(questionId);
        if (question?.delegationId !== delegationId) throw unavailable();
        return question;
    }

    private answerAs(
        by: 'parent' | 'user',
        input: { delegationId: string; questionId: string; text: string },
    ): DelegationQuestionAnswerResult {
        const question = this.forDelegation(input.delegationId, input.questionId);
        const outcome = this.store.answer(question, by, input.text);
        if (outcome === 'answered') this.escalations.disarm(question.id);
        return { outcome };
    }

    private cancelForDelegation(
        delegationId: string,
        reason: DelegationQuestionCancelReason,
    ): void {
        const question = this.store.openFor(delegationId);
        if (question) this.cancel(question, reason);
    }

    /**
     * The open question of a delegation, for `wait` to report.
     */
    openId(delegationId: string): string | undefined {
        return this.store.openFor(delegationId)?.id;
    }

    /**
     * Opens a question for the delegating Agent, as the delegated Agent running in the caller's Terminal. The question
     * is bound to that Agent's launch and Endpoint generation.
     */
    ask(
        authority: DelegationAuthority,
        input: { text: string; options?: string[]; requestId?: string },
    ): DelegationQuestionAskResult {
        const { principal, callerTerminalId } = authority;
        if (!callerTerminalId || principal.kind !== 'agent')
            throw new CaxriError('FORBIDDEN', 'Only a delegated Agent asks a question');
        const task = this.host.activeForTerminal(callerTerminalId);
        if (!task?.launchId)
            throw new CaxriError('NOT_FOUND', 'This Agent is not running a delegated task');
        const { result, opened } = this.store.ask(
            {
                delegationId: task.receipt.delegationId,
                sessionId: task.receipt.sessionId,
                childLaunchId: task.launchId,
                childGeneration: principal.generation,
            },
            input,
        );
        if (opened) {
            this.escalations.arm(opened.id, opened.sessionId, {
                terminalId: task.receipt.callerTerminalId,
                launchId: task.callerLaunchId,
            });
            if (this.host.presence.isGone(task.receipt.callerTerminalId, task.callerLaunchId))
                this.store.escalate(opened.id, 'parent_gone');
        }
        return result;
    }

    /**
     * Waits for the question the caller asked to close. Every pass re-verifies the asking launch, so an Agent restarted
     * in the same Terminal cannot read an answer meant for its predecessor.
     */
    async askWait(
        authority: DelegationAuthority,
        input: { questionId: string; timeoutMs: number },
        signal?: AbortSignal,
    ): Promise<DelegationQuestionWaitResult> {
        this.askedBy(authority, input.questionId);
        if (this.waiterCount >= MAX_QUESTION_WAITERS)
            throw new CaxriError('CAPACITY', 'Too many question waiters');
        this.waiterCount++;
        try {
            return await pollQuestion(
                () => this.askedBy(authority, input.questionId),
                () => this.host.isClosed(),
                input.timeoutMs,
                signal,
            );
        } finally {
            this.waiterCount--;
        }
    }

    /**
     * Withdraws the caller's own open question.
     */
    askCancel(authority: DelegationAuthority, questionId: string): DelegationQuestionCancelResult {
        const question = this.askedBy(authority, questionId);
        return {
            outcome: this.cancel(question, 'child_cancelled') ? 'cancelled' : 'already_closed',
        };
    }

    /**
     * The open questions of the caller's own tasks, or of one of them. Carries question text: the delegating Agent is
     * the only Agent that reads it.
     */
    list(authority: DelegationAuthority, delegationId?: string): DelegationQuestionsResult {
        const ids = delegationId
            ? [this.host.owned(delegationId, authority, 'existing').receipt.delegationId]
            : listOwnedDelegations(this.host.options.database, authority, {
                  active: true,
                  limit: MAX_LISTED_QUESTIONS,
              }).delegations.map((receipt) => receipt.delegationId);
        const questions: DelegationQuestionEntry[] = Array.from(
            this.store.openForMany(ids).values(),
            (question) => ({
                delegationId: question.delegationId,
                sessionId: question.sessionId,
                questionId: question.id,
                text: question.text,
                ...(question.options && { options: question.options }),
                askedAt: question.askedAt,
                escalated: question.escalatedAt !== undefined,
            }),
        );
        return { questions: questions.slice(0, MAX_LISTED_QUESTIONS) };
    }

    /**
     * An answer from the Agent that delegated the task.
     */
    answer(
        authority: DelegationAuthority,
        input: { delegationId: string; questionId: string; text: string },
    ): DelegationQuestionAnswerResult {
        this.host.owned(input.delegationId, authority, 'existing');
        return this.answerAs('parent', input);
    }

    /**
     * An answer from the user, through the owner-only `agent.delegation.questionAnswer`.
     */
    answerAsUser(input: {
        delegationId: string;
        questionId: string;
        text: string;
    }): DelegationQuestionAnswerResult {
        if (!this.host.options.database.agentDelegations.get(input.delegationId))
            throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        return this.answerAs('user', input);
    }

    /**
     * The open question of a delegation, text included, for the owner's Session view.
     */
    detail(delegationId: string): DelegationQuestionDetailResult {
        if (!this.host.options.database.agentDelegations.get(delegationId))
            throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        const question = this.store.openFor(delegationId);
        if (!question) return {};
        return {
            question: {
                questionId: question.id,
                text: question.text,
                ...(question.options && { options: question.options }),
                askedAt: question.askedAt,
                escalated: question.escalatedAt !== undefined,
            },
        };
    }

    /**
     * A task ended (settled, stopped, or failed): its open question can no longer be answered.
     */
    taskEnded(delegationId: string): void {
        this.cancelForDelegation(delegationId, 'task_ended');
    }

    /**
     * A Terminal interruption: a person typing into the asking Agent's Terminal makes its question moot (`taken_over`),
     * and a Host-side retirement of a launch escalates the questions whose delegating Agent it was. The caller has
     * already set a startup prompt answer aside.
     */
    interrupted(
        terminalId: string,
        activeDelegationId: string | undefined,
        isHumanInput: boolean,
        retiredLaunchId?: string,
    ): void {
        if (isHumanInput) {
            if (activeDelegationId) this.cancelForDelegation(activeDelegationId, 'taken_over');
        } else if (retiredLaunchId) {
            this.host.presence.retire(retiredLaunchId);
            this.escalations.parentRetired(terminalId, retiredLaunchId);
        }
    }

    /**
     * Server Core restarted: every asking Agent's wait is gone.
     */
    reset(): void {
        this.store.cancelAll('host_reset');
    }

    forget(sessionIds: readonly string[]): void {
        this.escalations.forgetSessions(sessionIds);
    }

    close(): void {
        this.escalations.close();
    }
}

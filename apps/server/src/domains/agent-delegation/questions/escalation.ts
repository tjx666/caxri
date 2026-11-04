import type { DelegationQuestionEscalationReason } from '@caxri/protocol';
import { QUESTION_ESCALATION_GRACE_MS } from '@caxri/protocol';

/**
 * The Agent that delegated the task: the Terminal and the exact launch that created it.
 */
export interface QuestionParent {
    terminalId?: string;
    launchId?: string;
}

interface Watch {
    sessionId: string;
    parent: QuestionParent;
    timer: NodeJS.Timeout;
}

/**
 * Hands an open question to the user when the delegating Agent will not answer it. Two things do that: the fixed grace
 * period elapsing, and the delegating Agent's original launch being definitively gone (retired, or its Terminal
 * deleted). Escalation is only a mark; it never answers or cancels the question.
 *
 * The state is in memory on purpose: every open question is cancelled when Server Core restarts, so a timer or an index
 * entry never outlives the lifetime that created it.
 */
export class QuestionEscalations {
    private readonly watches = new Map<string, Watch>();

    constructor(
        private readonly escalate: (
            questionId: string,
            reason: DelegationQuestionEscalationReason,
        ) => void,
        private readonly graceMs = QUESTION_ESCALATION_GRACE_MS,
    ) {}

    /**
     * Starts the grace period of an open question and indexes it by its delegating Agent's launch.
     */
    arm(questionId: string, sessionId: string, parent: QuestionParent): void {
        this.disarm(questionId);
        const timer = setTimeout(() => {
            this.disarm(questionId);
            this.escalate(questionId, 'grace_elapsed');
        }, this.graceMs);
        timer.unref();
        this.watches.set(questionId, { sessionId, parent, timer });
    }

    disarm(questionId: string): void {
        const watch = this.watches.get(questionId);
        if (!watch) return;
        clearTimeout(watch.timer);
        this.watches.delete(questionId);
    }

    /**
     * Stops watching the questions of Sessions that are being deleted.
     */
    forgetSessions(sessionIds: readonly string[]): void {
        const doomed = new Set(sessionIds);
        for (const [questionId, watch] of this.watches)
            if (doomed.has(watch.sessionId)) this.disarm(questionId);
    }

    /**
     * The launch `launchId` of `terminalId` retired for good (a Host-side retirement, not a person typing). Escalates
     * every open question whose delegating Agent was exactly that launch. Starting, suspending, or a launch that merely
     * has no ID yet never reaches here.
     */
    parentRetired(terminalId: string, launchId: string): void {
        for (const [questionId, { parent }] of this.watches)
            if (parent.terminalId === terminalId && parent.launchId === launchId) {
                this.disarm(questionId);
                this.escalate(questionId, 'parent_gone');
            }
    }

    close(): void {
        for (const watch of this.watches.values()) clearTimeout(watch.timer);
        this.watches.clear();
    }
}

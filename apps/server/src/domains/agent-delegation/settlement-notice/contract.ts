/**
 * How a notice ended up, as a closed enum for the log.
 */
export type NoticeOutcome = 'pending' | 'deferred' | 'delivered' | 'skipped' | 'unknown' | 'failed';

/**
 * Why a notice was held back or dropped, as a closed enum for the log.
 */
export type NoticeReason =
    /**
     * The caller Chat is in a turn, or has queued messages.
     */
    | 'busy'
    /**
     * The caller has an open `wait` that reports the event itself.
     */
    | 'waiter'
    /**
     * The caller already read the outcome through `wait` or `result`.
     */
    | 'acknowledged'
    /**
     * A PTY caller has typed text that was not submitted.
     */
    | 'draft'
    /**
     * A PTY caller has no finished turn proven idle.
     */
    | 'no_idle_proof'
    /**
     * The caller is another launch or Endpoint generation than the one that delegated the task.
     */
    | 'launch_changed'
    /**
     * The caller's Terminal is gone.
     */
    | 'caller_gone'
    /**
     * The task was not delegated by a managed Agent.
     */
    | 'external'
    /**
     * The task went to a Session its creator gave up (`handoff`).
     */
    | 'handoff'
    /**
     * The task went to a Session its creator does not wait for (`independent`).
     */
    | 'independent'
    /**
     * Caxri Bot delegated the task and keeps its own notifier.
     */
    | 'bot'
    /**
     * A retry of the failed task is planned or running; its successor reports the outcome.
     */
    | 'retry_pending'
    /**
     * The caller waits on an approval, was stopped, or waits for a usage limit.
     */
    | 'paused'
    /**
     * The question was answered, or the request decided or shown to the user, before the notice was sent.
     */
    | 'resolved';

/**
 * What the notices read about the questions and approvals of delegated tasks.
 */
export interface SettlementNoticeSources {
    /**
     * Whether the delegating Agent may decide a permission request of the task now: covered, and not yet shown to the
     * user.
     */
    isApprovalDecidable(delegationId: string): boolean;
    /**
     * Whether the question is still open and waits on the delegating Agent, not yet shown to the user.
     */
    isQuestionWithParent(delegationId: string, questionId: string): boolean;
    /**
     * Whether the user's hand-back grant still stands: not yet used by the follow-up and not dropped.
     */
    isHandBackPending(grantId: string): boolean;
}

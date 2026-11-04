import type { AgentDelegationSession } from '../agent-delegation-sessions.js';

type AgentDelegationFailure = NonNullable<AgentDelegationSession['failure']>;

/**
 * Failures a `failed` task can carry that are not the Agent failing at the task: the user took over, the target changed
 * or was refused, the caller stopped it, a restart cut it short, or it waits on the user. The Server's `fail()` writes
 * status `failed` for them, but their row wears no red cross, so a count must not include them either. Kept in step
 * with the `failed` glyph of the Desktop `delegationCopy` (a unit test pins the parity).
 */
const NON_FAILURE_FAILURES: ReadonlySet<AgentDelegationFailure> = new Set([
    'caller_stopped',
    'correlation_missing',
    'host_reset',
    'human_input',
    'payload_overflow',
    'permission_required',
    'result_missing',
    'session_changed',
    'startup_waiting',
    'target_busy',
    'target_changed',
    'target_not_ready',
]);

/**
 * Whether a failed task has a scheduled retry waiting for its time (`retryScheduledFor`). The task itself stays failed
 * and nothing runs, but the user has handled it: it reads as waiting, not as a failure. `retriedAs` is then the
 * reserved successor, so a reader of `retriedAs` alone would mistake the wait for a started retry.
 */
export function isDelegationRetryPending(
    entry: Pick<AgentDelegationSession, 'retriedAs' | 'retryScheduledFor'>,
): boolean {
    return entry.retryScheduledFor !== undefined && entry.retriedAs !== undefined;
}

/**
 * Whether the newest delegation that runs in a Session ended in a real failure: status `failed` with a failure that is
 * not in {@link NON_FAILURE_FAILURES}. `interrupted` is a task someone stopped or a restart cut short,
 * `human_intervened` means the user took over, and `answer_unavailable` is a finished turn whose answer could not be
 * collected; none of those is the Agent failing at the task. A failure with a pending scheduled retry is waiting, not
 * failed ({@link isDelegationRetryPending}).
 */
export function isDelegationFailed(
    entry: Pick<AgentDelegationSession, 'failure' | 'status'> &
        Partial<Pick<AgentDelegationSession, 'retriedAs' | 'retryScheduledFor'>>,
): boolean {
    return (
        entry.status === 'failed' &&
        (entry.failure === undefined || !NON_FAILURE_FAILURES.has(entry.failure)) &&
        !isDelegationRetryPending(entry)
    );
}

/**
 * A task that waits on the user: its Agent asked a question or a permission, sits at a first-run prompt in its
 * Terminal, or asked the Agent that delegated it a question or a permission request that escalated to the user
 * (`waitingOn` is `user`). `permission_required` can be a question rather than an approval, so no copy calls it an
 * approval unless the entry carries an `approval`. A blocked task whose request still waits on the Agent that delegated
 * it (`waitingOn` is `parent`) is not this: the user has nothing to do yet.
 */
export function isDelegationNeedsInput(
    entry: Pick<AgentDelegationSession, 'failure' | 'status'> &
        Partial<Pick<AgentDelegationSession, 'waitingOn'>>,
): boolean {
    return (
        entry.waitingOn === 'user' ||
        (entry.waitingOn !== 'parent' &&
            entry.status === 'blocked' &&
            (entry.failure === 'permission_required' || entry.failure === 'startup_waiting'))
    );
}

type RetryChainEntry = Pick<AgentDelegationSession, 'delegationId' | 'retriedAs' | 'retryOf'>;

/**
 * Drops each failed entry a retry superseded, so a chain of attempts counts and lists as its newest attempt only.
 *
 * The feed holds one entry per Session, its newest task. A fresh retry runs in another Session, so the failed entry
 * names the successor in `retriedAs` and the successor entry is `delegationId`. A resume retry reuses the Session, so
 * the failed task is no longer any entry's `delegationId`: the Session's entry is the new task with `retryOf` set. A
 * mixed chain (fresh, then resume of the successor) leaves the original `retriedAs` naming a task that is now the
 * successor's `retryOf`. An entry is therefore superseded when its `retriedAs` equals another entry's `delegationId` or
 * `retryOf`. A successor missing from the list (pruned, or created by another Session) keeps the failed entry. Two or
 * more resume retries in a row hide the middle task from every entry, so a chain that long under a fresh retry is still
 * listed at its first attempt.
 */
export function collapseRetryChains<T extends RetryChainEntry>(entries: readonly T[]): T[] {
    const successors = new Set<string>();
    for (const entry of entries) {
        if (entry.delegationId !== undefined) successors.add(entry.delegationId);
        if (entry.retryOf !== undefined) successors.add(entry.retryOf);
    }
    return entries.filter(
        (entry) => entry.retriedAs === undefined || !successors.has(entry.retriedAs),
    );
}

/**
 * What a delegated Session needs from the user, for the tree-wide roll-up (`agent.delegation.attention`):
 *
 * - `approval`: a pending permission request that waits on the user.
 * - `question`: an escalated question (waiting on the user) with no approval.
 * - `input`: a blocked task at a permission or first-run prompt the entry carries no summary for.
 * - `failed`: a real failure ({@link isDelegationFailed}) that no retry replaced.
 *
 * Absent for everything else: a running or finished task, a request still held by the Agent that delegated it
 * (`waitingOn` is `parent`), a failure with a scheduled retry (the user already handled it), a failure a started retry
 * superseded (`retriedAs`), and the non-failure endings of {@link NON_FAILURE_FAILURES}. Pass the entries after
 * {@link collapseRetryChains}: this predicate does not see a successor in another entry.
 */
export function delegationAttentionKind(
    entry: Pick<AgentDelegationSession, 'failure' | 'status'> &
        Partial<
            Pick<
                AgentDelegationSession,
                'approval' | 'question' | 'retriedAs' | 'retryScheduledFor' | 'waitingOn'
            >
        >,
): 'approval' | 'question' | 'input' | 'failed' | undefined {
    if (entry.status === 'failed' && isDelegationRetryPending(entry)) return undefined;
    if (isDelegationFailed(entry)) return entry.retriedAs === undefined ? 'failed' : undefined;
    if (!isDelegationNeedsInput(entry)) return undefined;
    if (entry.approval !== undefined) return 'approval';
    return entry.question !== undefined ? 'question' : 'input';
}

export type DelegationAttentionKind = NonNullable<ReturnType<typeof delegationAttentionKind>>;

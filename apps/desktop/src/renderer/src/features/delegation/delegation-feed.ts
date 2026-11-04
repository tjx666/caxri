import type {
    AgentDelegationReceipt,
    AgentDelegationSession,
    SessionRecord,
} from '@caxri/protocol';
import { isRetryableDelegationFailure, MAX_DELEGATION_CREATORS } from '@caxri/protocol';

type AgentDelegationFailure = NonNullable<AgentDelegationReceipt['failure']>;

/**
 * Code-point order, independent of the locale, so the same ids always sort the same way.
 */
function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The creating Sessions to ask `agent.delegation.sessions` about, as the read's creator-id lists: the distinct direct
 * creators of the given nested Sessions, sorted so the same set always produces the same query keys, in chunks of the
 * most ids one read accepts.
 *
 * The read is keyed by creator, not by host: a chain flattens onto one host in the tree, but the feed records each
 * Session under the Session that directly created it, which may itself be a nested Session. Asking about the direct
 * creators therefore covers every nested row, and is a superset of the hosts.
 */
export function delegationFeedCreatorIdChunks(
    nestedSessions: ReadonlyArray<Pick<SessionRecord, 'createdBySessionId'>>,
): string[][] {
    const creatorIds = new Set<string>();
    for (const session of nestedSessions)
        if (session.createdBySessionId !== undefined) creatorIds.add(session.createdBySessionId);
    const sorted = [...creatorIds].toSorted(compareIds);
    const chunks: string[][] = [];
    for (let start = 0; start < sorted.length; start += MAX_DELEGATION_CREATORS)
        chunks.push(sorted.slice(start, start + MAX_DELEGATION_CREATORS));
    return chunks;
}

/**
 * Failures a `failed` task can carry that are not the Agent failing at the task: the user took over, the target changed
 * or was refused, the caller stopped it, a restart cut it short, or it waits on the user. The Server's `fail()` writes
 * status `failed` for them, but their row wears no red cross, so the header must not count them as failed either. Kept
 * in step with the `failed` glyph of `delegationCopy` (a unit test pins the parity).
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
 * it (`waitingOn` is `parent`) is {@link isDelegationAsking}, not this: the user has nothing to do yet.
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

/**
 * A task whose Agent asked the Agent that delegated it a question or a permission request, still inside the grace
 * period. The user has nothing to do yet, so it is muted and never counted as needing attention; once it escalates it
 * is {@link isDelegationNeedsInput}.
 */
export function isDelegationAsking(
    entry: Partial<Pick<AgentDelegationSession, 'waitingOn'>>,
): boolean {
    return entry.waitingOn === 'parent';
}

/**
 * Whether the owner may be offered Retry for this entry: the newest task failed with a failure the Server accepts
 * (`isRetryableDelegationFailure`), nothing retried it yet, and the user did not take the Session over. Only a hint to
 * show the action; the Server decides again when the options are read and when the retry runs.
 */
export function isRetryCandidate(
    entry: Pick<
        AgentDelegationSession,
        'delegationId' | 'failure' | 'retriedAs' | 'status' | 'takenOverAt'
    >,
): boolean {
    return (
        entry.delegationId !== undefined &&
        entry.retriedAs === undefined &&
        entry.takenOverAt === undefined &&
        entry.status !== undefined &&
        isRetryableDelegationFailure({ failure: entry.failure, status: entry.status })
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
 * The attempt number of each retried task, by task ID: 2 for the first retry, 3 for a retry of that, and so on, found
 * by walking `retryOf` through the entries. A task nothing retries is absent, and a chain whose earlier tasks are gone
 * from the list counts only the attempts it can see.
 */
export function delegationAttemptNumbers(
    entries: ReadonlyArray<Pick<AgentDelegationSession, 'delegationId' | 'retryOf'>>,
): ReadonlyMap<string, number> {
    const byTask = new Map<string, Pick<AgentDelegationSession, 'delegationId' | 'retryOf'>>();
    for (const entry of entries)
        if (entry.delegationId !== undefined) byTask.set(entry.delegationId, entry);
    const attempts = new Map<string, number>();
    for (const entry of entries)
        if (entry.delegationId !== undefined && entry.retryOf !== undefined)
            attempts.set(
                entry.delegationId,
                attemptNumber(entry.delegationId, entry.retryOf, byTask),
            );
    return attempts;
}

/**
 * Counts the attempts before a task by following `retryOf` through the tasks the list still holds; a cycle ends the
 * walk.
 */
function attemptNumber(
    taskId: string,
    retryOf: string,
    byTask: ReadonlyMap<string, Pick<AgentDelegationSession, 'delegationId' | 'retryOf'>>,
): number {
    const seen = new Set([taskId]);
    let attempt = 2;
    let previous = byTask.get(retryOf);
    while (previous?.delegationId !== undefined && !seen.has(previous.delegationId)) {
        seen.add(previous.delegationId);
        if (previous.retryOf === undefined) return attempt;
        attempt += 1;
        previous = byTask.get(previous.retryOf);
    }
    return attempt;
}

/**
 * The nested Sessions whose delegation failed, as a sorted list: plain data, so React Query's structural sharing keeps
 * the same reference while the answer is unchanged and a row only re-renders when its own status moves. A failure a
 * retry superseded (`retriedAs`) is left out: its row stays, but the red cross belongs to the attempt that replaced
 * it.
 */
export function failedDelegationSessionIds(
    entries: ReadonlyArray<
        Pick<AgentDelegationSession, 'failure' | 'retriedAs' | 'sessionId' | 'status'> &
            Partial<Pick<AgentDelegationSession, 'retryScheduledFor'>>
    >,
): string[] {
    return entries
        .filter((entry) => isDelegationFailed(entry) && entry.retriedAs === undefined)
        .map((entry) => entry.sessionId)
        .toSorted(compareIds);
}

/**
 * Whether the task's pending permission request is the user's to decide: the feed carries an `approval` summary and the
 * task waits on the user (the request was not covered, or its grace ended). Only a Chat child ever has one; a Terminal
 * child never does. The sidebar keeps the amber cue for it until the request is decided (`sessionStatus`).
 */
export function isDelegationApprovalPending(
    entry: Partial<Pick<AgentDelegationSession, 'approval' | 'waitingOn'>>,
): boolean {
    return entry.approval !== undefined && entry.waitingOn === 'user';
}

/**
 * The nested Sessions whose permission request waits on the user, as a sorted list for the same reason as
 * {@link failedDelegationSessionIds}.
 */
export function approvalPendingSessionIds(
    entries: ReadonlyArray<
        Pick<AgentDelegationSession, 'sessionId'> &
            Partial<Pick<AgentDelegationSession, 'approval' | 'waitingOn'>>
    >,
): string[] {
    return entries
        .filter((entry) => isDelegationApprovalPending(entry))
        .map((entry) => entry.sessionId)
        .toSorted(compareIds);
}

/**
 * How many delegated Sessions a header counts as needing the user, as failed, and as waiting for a scheduled retry. A
 * task waiting on a question or a permission (`isDelegationNeedsInput`), a task that failed (`isDelegationFailed`), and
 * a failure whose retry is scheduled (`isDelegationRetryPending`) are separate counts; an `answer_unavailable` task is
 * none of them, because its work may be done. Pass the collapsed list (`collapseRetryChains`) so a retried failure no
 * longer counts. A pending retry survives the collapse (its successor does not exist yet), so it is counted here as
 * waiting, never as failed. A task asking the Agent that delegated it (`isDelegationAsking`) is counted apart as
 * `asking`: it is not attention, and an escalated question is `needsInput`.
 */
export function delegationAttentionCounts(
    entries: ReadonlyArray<
        Pick<AgentDelegationSession, 'failure' | 'status'> &
            Partial<
                Pick<
                    AgentDelegationSession,
                    'approval' | 'retriedAs' | 'retryScheduledFor' | 'waitingOn'
                >
            >
    >,
): { approvals: number; asking: number; failed: number; needsInput: number; waiting: number } {
    let approvals = 0;
    let asking = 0;
    let failed = 0;
    let needsInput = 0;
    let waiting = 0;
    for (const entry of entries) {
        if (entry.status === 'failed' && isDelegationRetryPending(entry)) waiting += 1;
        else if (isDelegationFailed(entry)) failed += 1;
        else if (isDelegationNeedsInput(entry)) {
            needsInput += 1;
            if (entry.approval !== undefined) approvals += 1;
        } else if (isDelegationAsking(entry)) asking += 1;
    }
    return { approvals, asking, failed, needsInput, waiting };
}

/**
 * How long a delegated task has run: from its creation to its settling, or to `now` while it is active. `undefined`
 * when the entry has no task or the clock reads before the creation time.
 */
export function delegationElapsedMs(
    entry: Pick<AgentDelegationSession, 'createdAt' | 'settledAt' | 'status'>,
    now: number,
): number | undefined {
    if (entry.createdAt === undefined) return undefined;
    const end = entry.settledAt ?? now;
    return end >= entry.createdAt ? end - entry.createdAt : undefined;
}

import type { AgentDelegationSession, SessionRecord } from '@caxri/protocol';
import {
    isDelegationFailed,
    isDelegationNeedsInput,
    isDelegationRetryPending,
    isRetryableDelegationFailure,
    MAX_DELEGATION_CREATORS,
} from '@caxri/protocol';

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
 * Whether the task waits on the user for a permission request or an escalated question: the feed carries an `approval`
 * summary or an open `question`, and the task waits on the user (the request was not covered, or its grace ended). The
 * sidebar keeps the amber cue for it until the request is decided or the question is answered (`sessionStatus`); an
 * escalated question raises no notification, only this cue.
 */
export function isDelegationUserPending(
    entry: Partial<Pick<AgentDelegationSession, 'approval' | 'question' | 'waitingOn'>>,
): boolean {
    return (
        (entry.approval !== undefined || entry.question !== undefined) && entry.waitingOn === 'user'
    );
}

/**
 * The nested Sessions whose permission request or escalated question waits on the user, as a sorted list for the same
 * reason as {@link failedDelegationSessionIds}.
 */
export function userPendingSessionIds(
    entries: ReadonlyArray<
        Pick<AgentDelegationSession, 'sessionId'> &
            Partial<Pick<AgentDelegationSession, 'approval' | 'question' | 'waitingOn'>>
    >,
): string[] {
    return entries
        .filter((entry) => isDelegationUserPending(entry))
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

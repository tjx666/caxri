import type {
    AgentDelegationReceipt,
    AgentDelegationSession,
    SessionRecord,
} from '@caxri/protocol';
import { MAX_DELEGATION_CREATORS } from '@caxri/protocol';

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
 * Whether the newest delegation that runs in a Session ended in a real failure: status `failed` with a failure that is
 * not in {@link NON_FAILURE_FAILURES}. `interrupted` is a task someone stopped or a restart cut short,
 * `human_intervened` means the user took over, and `answer_unavailable` is a finished turn whose answer could not be
 * collected; none of those is the Agent failing at the task.
 */
export function isDelegationFailed(
    entry: Pick<AgentDelegationSession, 'failure' | 'status'>,
): boolean {
    return (
        entry.status === 'failed' &&
        (entry.failure === undefined || !NON_FAILURE_FAILURES.has(entry.failure))
    );
}

/**
 * A task that waits on the user: its Agent asked a question or a permission, or sits at a first-run prompt in its
 * Terminal. `permission_required` can be a question rather than an approval, so no copy calls it an approval.
 */
export function isDelegationNeedsInput(
    entry: Pick<AgentDelegationSession, 'failure' | 'status'>,
): boolean {
    return (
        entry.status === 'blocked' &&
        (entry.failure === 'permission_required' || entry.failure === 'startup_waiting')
    );
}

/**
 * The nested Sessions whose delegation failed, as a sorted list: plain data, so React Query's structural sharing keeps
 * the same reference while the answer is unchanged and a row only re-renders when its own status moves.
 */
export function failedDelegationSessionIds(
    entries: ReadonlyArray<Pick<AgentDelegationSession, 'failure' | 'sessionId' | 'status'>>,
): string[] {
    return entries
        .filter((entry) => isDelegationFailed(entry))
        .map((entry) => entry.sessionId)
        .toSorted(compareIds);
}

/**
 * How many delegated Sessions a header counts as needing the user and as failed. A task waiting on a question or a
 * permission (`isDelegationNeedsInput`) and a task that failed (`isDelegationFailed`) are separate counts; an
 * `answer_unavailable` task is neither, because its work may be done.
 */
export function delegationAttentionCounts(
    entries: ReadonlyArray<Pick<AgentDelegationSession, 'failure' | 'status'>>,
): { failed: number; needsInput: number } {
    let failed = 0;
    let needsInput = 0;
    for (const entry of entries) {
        if (isDelegationFailed(entry)) failed += 1;
        else if (isDelegationNeedsInput(entry)) needsInput += 1;
    }
    return { failed, needsInput };
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

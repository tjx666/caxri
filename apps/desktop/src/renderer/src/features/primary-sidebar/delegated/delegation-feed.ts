import type { AgentDelegationSession, SessionRecord } from '@caxri/protocol';
import { MAX_DELEGATION_CREATORS } from '@caxri/protocol';

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
 * Whether the newest delegation that runs in a Session ended in `failed`. Only `failed` counts: `interrupted` is a task
 * someone stopped or a restart cut short, `human_intervened` means the user took over, and `answer_unavailable` is a
 * finished turn whose answer could not be collected; none of those is the Agent failing at the task.
 */
export function isDelegationFailed(entry: Pick<AgentDelegationSession, 'status'>): boolean {
    return entry.status === 'failed';
}

/**
 * The nested Sessions whose delegation failed, as a sorted list: plain data, so React Query's structural sharing keeps
 * the same reference while the answer is unchanged and a row only re-renders when its own status moves.
 */
export function failedDelegationSessionIds(
    entries: ReadonlyArray<Pick<AgentDelegationSession, 'sessionId' | 'status'>>,
): string[] {
    return entries
        .filter((entry) => isDelegationFailed(entry))
        .map((entry) => entry.sessionId)
        .toSorted(compareIds);
}

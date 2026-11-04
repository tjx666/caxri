import type {
    AgentDelegationAttentionItem,
    AgentDelegationAttentionReply,
    AgentDelegationSession,
    DelegationAttentionKind,
} from '@caxri/protocol';
import {
    collapseRetryChains,
    delegationAttentionKind,
    MAX_DELEGATION_ATTENTION_ITEMS,
} from '@caxri/protocol';

import { delegatedDescendants } from '../tree';
import type { DelegationSessionsSource } from './sessions';
import { delegationEntries } from './sessions';

/**
 * Most urgent first: a permission request, an escalated question, a blocked prompt, then a failure.
 */
const KIND_RANK: Record<DelegationAttentionKind, number> = {
    approval: 0,
    question: 1,
    input: 2,
    failed: 3,
};

/**
 * `agent.delegation.attention`: the Sessions below `rootSessionId`'s direct children whose newest task needs the user,
 * for the parent strip that otherwise lists direct children only.
 *
 * The order of the steps is the contract, because a cap applied early would hide what the user still has to do:
 *
 * 1. Walk the `delegated` and `consult` edges (depth and size bounded). A hand-off Session is the user's own continuation
 *    and is neither listed nor walked.
 * 2. Keep depth two and deeper; the direct children are the feed's rows and never repeat here.
 * 3. Pick each Session's representative task and fold retry chains ({@link collapseRetryChains}), so a failure that a retry
 *    replaced, or a failure whose retry is scheduled, is gone before any filter, rank or cap.
 * 4. Keep the entries with an attention kind ({@link delegationAttentionKind}), then drop Sessions that were deleted or
 *    archived since the edge was written.
 * 5. Rank by kind, newest first, and cut to {@link MAX_DELEGATION_ATTENTION_ITEMS}.
 *
 * `isPartial` is set when the walk stopped at a bound or when the cut dropped an item, so a header never claims a
 * complete count it did not read. Items carry ids and closed values only, never a step, summary, or question text.
 */
export function delegationAttention(
    source: DelegationSessionsSource,
    rootSessionId: string,
): AgentDelegationAttentionReply {
    const { database } = source;
    const { branchOf, parentOf, relationOf, isTruncated } = delegatedDescendants(
        database,
        rootSessionId,
    );
    const deepSessionIds = branchOf
        .entries()
        .filter(([sessionId, branch]) => sessionId !== branch)
        .map(([sessionId]) => sessionId)
        .toArray();
    const entries = collapseRetryChains(
        delegationEntries(
            source,
            deepSessionIds.map((sessionId) => ({
                sessionId,
                createdBySessionId: parentOf.get(sessionId)!,
                relation: relationOf.get(sessionId)!,
            })),
            { isSummary: false },
        ),
    );
    const ranked = entries
        .flatMap((entry) => {
            const kind = delegationAttentionKind(entry);
            return kind === undefined || !isLiveSession(database, entry) ? [] : [{ entry, kind }];
        })
        .toSorted(
            (left, right) =>
                KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
                (right.entry.createdAt ?? 0) - (left.entry.createdAt ?? 0) ||
                compareIds(left.entry.sessionId, right.entry.sessionId),
        );
    return {
        items: ranked.slice(0, MAX_DELEGATION_ATTENTION_ITEMS).map(({ entry }) => ({
            ...entry,
            branchSessionId: branchOf.get(entry.sessionId)!,
        })) satisfies AgentDelegationAttentionItem[],
        isPartial: isTruncated || ranked.length > MAX_DELEGATION_ATTENTION_ITEMS,
    };
}

/**
 * Whether the Session still exists and is not archived. Edges outlive a deleted Session, and an archived one is out of
 * the user's way, so neither is a to-do.
 */
function isLiveSession(
    database: DelegationSessionsSource['database'],
    entry: Pick<AgentDelegationSession, 'sessionId'>,
): boolean {
    const record = database.getSession(entry.sessionId);
    return record !== undefined && record.archivedAt === undefined;
}

function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

import type { SessionSearchEntry } from '@caxri/protocol';

/**
 * A ranked result that may belong to a fork group.
 */
interface ForkGroupMember {
    entry: SessionSearchEntry;
    forkGroup?: string;
}

/**
 * Folds the branches of one conversation into a single result. Forks copy their parent's earlier messages under a new
 * conversation ID, so a phrase from before the fork matches the original and every branch with the same excerpt. The
 * group keeps the rank of its best-ranked member and shows the most recently active branch, listing every branch under
 * it. `entries` must already be ranked.
 */
export function collapseForkGroups<T extends ForkGroupMember>(entries: readonly T[]): T[] {
    const groups = new Map<string, T[]>();
    for (const ranked of entries) {
        if (ranked.forkGroup === undefined) continue;
        const members = groups.get(ranked.forkGroup) ?? [];
        members.push(ranked);
        groups.set(ranked.forkGroup, members);
    }
    const collapsed: T[] = [];
    for (const ranked of entries) {
        const members = ranked.forkGroup === undefined ? undefined : groups.get(ranked.forkGroup);
        if (!members || members.length < 2) {
            collapsed.push(ranked);
            continue;
        }
        // The group is emitted where its best-ranked member sits; the later members were folded into it.
        if (members[0] !== ranked) continue;
        const branches = members.toSorted(
            (left, right) => right.entry.updatedAt - left.entry.updatedAt,
        );
        const latest = branches[0];
        collapsed.push({
            ...ranked,
            entry: { ...latest.entry, branches: branches.map(({ entry }) => entry) },
        });
    }
    return collapsed;
}

/**
 * `candidate` replacing `existing` for the same Session row, keeping the fork identity only `existing` carried. A
 * Session's own title match can outrank its index hit, and the branch it holds must still group with its siblings.
 */
export function keepForkIdentity<T extends ForkGroupMember>(candidate: T, existing: T): T {
    const forkGroup = candidate.forkGroup ?? existing.forkGroup;
    const totalMessages = candidate.entry.totalMessages ?? existing.entry.totalMessages;
    return {
        ...candidate,
        ...(forkGroup !== undefined && { forkGroup }),
        entry: { ...candidate.entry, ...(totalMessages !== undefined && { totalMessages }) },
    };
}

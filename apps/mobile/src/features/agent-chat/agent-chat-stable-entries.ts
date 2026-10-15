/**
 * Whether two JSON-like values hold the same data. Snapshot items a patch did not touch keep their identity
 * (`applyAgentChatPatch` copies only the items it changes), so the identity check settles most branches at once.
 */
export function isSameAgentChatValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
        return false;
    if (Array.isArray(left)) {
        if (!Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => isSameAgentChatValue(value, right[index]));
    }
    if (Array.isArray(right)) return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    if (keys.length !== Object.keys(rightRecord).length) return false;
    return keys.every(
        (key) =>
            Object.hasOwn(rightRecord, key) &&
            isSameAgentChatValue(leftRecord[key], rightRecord[key]),
    );
}

/**
 * The timeline rows with every row whose data did not change replaced by the object drawn last time, and the previous
 * array itself when no row changed. The timeline is rebuilt from the snapshot on every streamed patch (about every 16
 * ms), which made every row a new object; FlashList and the memoized rows then redrew the whole visible timeline for a
 * patch that touched one reply, which is what made scrolling during a reply stutter.
 */
export function stabilizeAgentChatEntries<Entry extends { id: string }>(
    previous: readonly Entry[],
    next: readonly Entry[],
): readonly Entry[] {
    if (previous === next) return next;
    const byId = new Map(previous.map((entry) => [entry.id, entry]));
    let isUnchanged = previous.length === next.length;
    const entries = next.map((entry, index) => {
        const last = byId.get(entry.id);
        const kept = last !== undefined && isSameAgentChatValue(last, entry) ? last : entry;
        if (kept !== previous[index]) isUnchanged = false;
        return kept;
    });
    return isUnchanged ? previous : entries;
}

/**
 * A per-list memory for {@link stabilizeAgentChatEntries}: each call stabilizes against the rows the previous call
 * returned. Calling it again with the same rows returns the same result, so a repeated render stays consistent.
 */
export function createAgentChatEntryStabilizer<Entry extends { id: string }>(): (
    next: readonly Entry[],
) => readonly Entry[] {
    let previous: readonly Entry[] = [];
    return (next) => {
        previous = stabilizeAgentChatEntries(previous, next);
        return previous;
    };
}

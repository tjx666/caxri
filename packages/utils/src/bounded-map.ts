/**
 * Inserts (or refreshes) `key` at the most-recently-used end of an insertion-ordered `Map` and evicts the oldest
 * entries until at most `maximum` remain. `Map` preserves insertion order, so deleting before setting is what moves an
 * existing key back to the end; without it a repeatedly read entry would still age out ahead of a stale one.
 */
export function rememberBounded<Key, Value>(
    entries: Map<Key, Value>,
    key: Key,
    value: Value,
    maximum: number,
): void {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > Math.max(1, maximum)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
    }
}

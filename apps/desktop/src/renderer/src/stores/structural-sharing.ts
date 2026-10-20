/**
 * Structural sharing for Server snapshots.
 *
 * `app.bootstrap` crosses the IPC boundary as freshly structured-cloned JSON, so every refresh hands the Renderer brand
 * new object identities even when nothing changed. Without this merge a single full-convergence refresh would
 * invalidate every `useStore` selector and rerender the whole tree. Merging both full and scoped snapshots against the
 * previous state keeps the identity of every deep-equal branch, so a Terminal title change only rerenders the consumers
 * of that Terminal.
 */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stable identity for an array element, so reordering or inserting does not discard the identity of the elements that
 * stayed the same. Falls back to positional matching when no key field exists.
 */
function elementKey(value: unknown): string | undefined {
    if (!isPlainObject(value)) return undefined;
    for (const field of ['id', 'sessionId', 'taskId', 'path'] as const) {
        const candidate = value[field];
        if (typeof candidate === 'string') return `${field}:${candidate}`;
    }
    return undefined;
}

function mergeArray(previous: readonly unknown[], next: readonly unknown[]): unknown[] {
    const byKey = new Map<string, unknown>();
    for (const value of previous) {
        const key = elementKey(value);
        if (key !== undefined && !byKey.has(key)) byKey.set(key, value);
    }
    let isIdentical = previous.length === next.length;
    const merged = next.map((value, index) => {
        const key = elementKey(value);
        const candidate = key !== undefined ? (byKey.get(key) ?? previous[index]) : previous[index];
        const result = mergeStructurally(candidate, value);
        if (result !== previous[index]) isIdentical = false;
        return result;
    });
    return isIdentical ? (previous as unknown[]) : merged;
}

function mergeObject(previous: PlainObject, next: PlainObject): PlainObject {
    const nextKeys = Object.keys(next);
    let isIdentical = nextKeys.length === Object.keys(previous).length;
    const merged: PlainObject = {};
    for (const key of nextKeys) {
        const value = mergeStructurally(previous[key], next[key]);
        merged[key] = value;
        if (!(value === previous[key] && Object.hasOwn(previous, key))) isIdentical = false;
    }
    return isIdentical ? previous : merged;
}

/**
 * Returns `previous` when `next` is deeply equal to it, and otherwise a copy of `next` that reuses every deep-equal
 * branch of `previous`.
 */
export function mergeStructurally<T>(previous: unknown, next: T): T {
    if (Object.is(previous, next)) return next;
    if (Array.isArray(previous) && Array.isArray(next)) return mergeArray(previous, next) as T;
    if (isPlainObject(previous) && isPlainObject(next)) return mergeObject(previous, next) as T;
    return next;
}

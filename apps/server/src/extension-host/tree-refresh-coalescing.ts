export interface TreeRefreshBatch {
    root: boolean;
    handles: ReadonlySet<string>;
}

/**
 * Combines one debounce window without losing an earlier branch. `undefined` is a root refresh and therefore wins; an
 * empty handle list represents an unknown or empty provider event and remains a no-op.
 */
export function mergeTreeRefresh(
    current: TreeRefreshBatch | undefined,
    nextHandles: readonly string[] | undefined,
): TreeRefreshBatch | undefined {
    if (nextHandles === undefined) return { root: true, handles: new Set() };
    if (nextHandles.length === 0 || current?.root) return current;
    return {
        root: false,
        handles: new Set([...(current?.handles ?? []), ...nextHandles]),
    };
}

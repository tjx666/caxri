/**
 * Keyboard movement shared by every ARIA `role="tree"` widget in the Renderer (Files, Source Control, extension tree
 * views, the PrimarySidebar, Process Explorer). Each tree hands over its own flattened row model in depth-first
 * document order; only the arithmetic lives here, so a fix to one movement (such as ArrowRight on an expanded but empty
 * folder) reaches every tree at once.
 *
 * - `next` / `previous` / `first` / `last` step over rows that cannot take focus (a loading notice, an inline create
 *   field) and stop at either edge instead of wrapping.
 * - `parent` is the nearest earlier row one level shallower, which depth-first order guarantees is the enclosing row.
 * - `firstChild` is the first focusable row inside the row's visible subtree. An expanded row with nothing focusable
 *   under it (empty, still loading, failed) has none, so ArrowRight there stays put instead of reaching a sibling.
 */
export type TreeNavigation = 'next' | 'previous' | 'first' | 'last' | 'parent' | 'firstChild';

export interface TreeRowModel<Row> {
    /**
     * Nesting level of a row; top-level rows share the smallest value.
     */
    depthOf: (row: Row) => number;
    /**
     * Whether a row can take roving focus. Defaults to every row.
     */
    isFocusable?: (row: Row) => boolean;
}

/**
 * The row index `action` moves focus to from `from`, or `undefined` when it does not move focus.
 */
export function treeNavigationTarget<Row>(
    rows: readonly Row[],
    from: number,
    action: TreeNavigation,
    { depthOf, isFocusable = () => true }: TreeRowModel<Row>,
): number | undefined {
    const scan = (start: number, step: 1 | -1, isPastEnd?: (index: number) => boolean) => {
        for (let index = start; index >= 0 && index < rows.length; index += step) {
            if (isPastEnd?.(index)) return;
            if (isFocusable(rows[index])) return index;
        }
        return;
    };
    switch (action) {
        case 'first': {
            return scan(0, 1);
        }
        case 'last': {
            return scan(rows.length - 1, -1);
        }
        case 'next': {
            return from < 0 || from >= rows.length ? undefined : scan(from + 1, 1);
        }
        case 'previous': {
            return from < 0 || from >= rows.length ? undefined : scan(from - 1, -1);
        }
        case 'parent': {
            const row = rows.at(from);
            if (row === undefined || from < 0) return undefined;
            const depth = depthOf(row);
            for (let index = from - 1; index >= 0; index -= 1)
                if (depthOf(rows[index]) < depth) return index;
            return undefined;
        }
        case 'firstChild': {
            const row = rows.at(from);
            if (row === undefined || from < 0 || !isFocusable(row)) return undefined;
            const depth = depthOf(row);
            return scan(from + 1, 1, (index) => depthOf(rows[index]) <= depth);
        }
    }
}

export type TreeVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

/**
 * The movement each vertical key makes in every tree.
 */
export const TREE_VERTICAL_NAVIGATION = {
    ArrowDown: 'next',
    ArrowUp: 'previous',
    End: 'last',
    Home: 'first',
} as const satisfies Record<TreeVerticalKey, TreeNavigation>;

export function isTreeVerticalKey(key: string): key is TreeVerticalKey {
    return Object.hasOwn(TREE_VERTICAL_NAVIGATION, key);
}

/**
 * {@link treeNavigationTarget} for a vertical key in a tree whose roving focus is tracked by row id. An id that went
 * stale (its row left the tree) restarts Up and Down from the first row, like a fresh tree.
 */
export function treeVerticalTargetId<Row extends { id: string }>(
    rows: readonly Row[],
    activeRowId: string | undefined,
    key: TreeVerticalKey,
    model: TreeRowModel<Row>,
): string | undefined {
    const from = rows.findIndex((row) => row.id === activeRowId);
    if (from === -1 && (key === 'ArrowDown' || key === 'ArrowUp')) return rows[0]?.id;
    const target = treeNavigationTarget(rows, from, TREE_VERTICAL_NAVIGATION[key], model);
    return target === undefined ? undefined : rows[target].id;
}

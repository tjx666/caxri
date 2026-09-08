import type { TreeItemDto } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

export interface VisibleItemRow {
    kind: 'item';
    depth: number;
    /**
     * Whether the row's children are currently shown below it.
     */
    isExpanded: boolean;
    item: TreeItemDto;
    parentHandle: string;
    /**
     * Flat index of the parent item row, or `-1` for root items.
     */
    parentIndex: number;
    /**
     * 1-based position among sibling item rows (`aria-posinset`).
     */
    positionInSet: number;
    /**
     * Number of sibling item rows including this one (`aria-setsize`).
     */
    setSize: number;
}

interface VisibleLoadingRow {
    kind: 'loading';
    depth: number;
    parentHandle: string;
}

interface VisibleErrorRow {
    kind: 'error';
    depth: number;
    message: string;
    parentHandle: string;
}

interface VisibleEmptyRow {
    kind: 'empty';
    depth: number;
    parentHandle: string;
}

export type VisibleRow = VisibleItemRow | VisibleLoadingRow | VisibleErrorRow | VisibleEmptyRow;

export function visibleRowKey(row: VisibleRow): string {
    return row.kind === 'item'
        ? `${row.item.handle}:${row.item.variant ?? 'item'}`
        : `${row.kind}:${row.parentHandle}`;
}

/**
 * Flattens the loaded tree into the rows the virtualizer renders. Sibling position and expansion are precomputed here
 * so a row never has to scan the whole list, and a row object is reused from `previous` when nothing about it changed:
 * a refresh replaces every `TreeItemDto` with a fresh but usually identical copy, and reusing the row keeps the per-row
 * React subtree (tooltip, menu, icon) from re-rendering for unchanged items.
 */
export function flattenVisibleRows(options: {
    children: ReadonlyMap<string, readonly TreeItemDto[]>;
    errors: ReadonlyMap<string, string>;
    isExpanded: (item: TreeItemDto) => boolean;
    loading: ReadonlySet<string>;
    previous?: readonly VisibleRow[];
    rootHandle: string;
}): VisibleRow[] {
    const { children, errors, isExpanded, loading, previous = [], rootHandle } = options;
    const previousByKey = new Map(previous.map((row) => [visibleRowKey(row), row]));
    const rows: VisibleRow[] = [];
    const push = (row: VisibleRow): void => {
        const candidate = previousByKey.get(visibleRowKey(row));
        rows.push(candidate && isEqual(candidate, row) ? candidate : row);
    };
    const append = (parentHandle: string, parentIndex: number, depth: number): void => {
        if (loading.has(parentHandle)) {
            push({ kind: 'loading', depth, parentHandle });
            return;
        }
        const error = errors.get(parentHandle);
        if (error) {
            push({ kind: 'error', depth, parentHandle, message: error });
            return;
        }
        const items = children.get(parentHandle) ?? [];
        if (children.has(parentHandle) && items.length === 0) {
            push({ kind: 'empty', depth, parentHandle });
            return;
        }
        for (const [index, item] of items.entries()) {
            const rowIndex = rows.length;
            // Matches the previous "next row is deeper" test: an expanded branch whose children have not been
            // requested yet renders nothing below it, so it is not announced as expanded.
            const isItemExpanded =
                isExpanded(item) &&
                (loading.has(item.handle) || errors.has(item.handle) || children.has(item.handle));
            push({
                kind: 'item',
                depth,
                isExpanded: isItemExpanded,
                item,
                parentHandle,
                parentIndex,
                positionInSet: index + 1,
                setSize: items.length,
            });
            if (isItemExpanded) append(item.handle, rowIndex, depth + 1);
        }
    };
    append(rootHandle, -1, 0);
    return rows;
}

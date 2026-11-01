import type { FileEntry, MethodResult } from '@caxri/protocol';

import type { TreeNavigation, TreeRowModel } from '../../../lib/tree-navigation';
import { treeNavigationTarget } from '../../../lib/tree-navigation';
import { isFileTreeDirectory } from './resource-explorer-state';

interface FileTreeRowBase {
    depth: number;
    /**
     * Stable identity for the virtualizer and React; unique across the flattened tree.
     */
    key: string;
    /**
     * Flat index of the directory row this row sits under, or `undefined` at the Project root.
     */
    parentRow: number | undefined;
}

export interface FileTreeEntryRow extends FileTreeRowBase {
    entry: FileEntry;
    /**
     * Zero-based position within the parent listing; `aria-posinset` is this plus one.
     */
    index: number;
    /**
     * Whether this row is a directory whose children are part of the flattened tree.
     */
    isExpanded: boolean;
    kind: 'entry';
    /**
     * Flat index of the last row inside this row's subtree; the row's own index when it has none.
     */
    lastDescendant: number;
    setSize: number;
}

export type FileTreeRow =
    | FileTreeEntryRow
    | (FileTreeRowBase & { directory: string; kind: 'create' })
    | (FileTreeRowBase & { directory: string; kind: 'empty' })
    | (FileTreeRowBase & { count: number; directory: string; kind: 'truncated' });

export interface FlattenFileTreeInput {
    /**
     * Directory whose inline "New file/folder" field is open, if any.
     */
    composingDirectory?: string;
    isExpanded: (path: string) => boolean;
    /**
     * The loaded listing of a directory, or `undefined` while it is pending or failed.
     */
    listing: (
        directory: string,
    ) => (Pick<MethodResult<'files.list'>, 'entries'> & { truncated?: boolean }) | undefined;
    root: string;
}

export interface FlattenedFileTree {
    /**
     * Every directory whose listing the visible tree needs: the root plus each expanded directory row, in tree order. A
     * directory is only included once its parent listing actually contains it, so a stale expanded path left behind by
     * a deleted folder is never requested.
     */
    directories: string[];
    rows: FileTreeRow[];
}

/**
 * Flattens the expanded part of the Files tree into the rows a virtualized list draws, in depth-first document order.
 *
 * This is the model the whole tree is navigated by: keyboard movement, reveal, and sticky ancestors all index into it
 * instead of reading rows out of the DOM, because a virtualized tree only mounts the rows near the viewport.
 */
export function flattenFileTree({
    composingDirectory,
    isExpanded,
    listing,
    root,
}: FlattenFileTreeInput): FlattenedFileTree {
    const rows: FileTreeRow[] = [];
    const directories: string[] = [];

    const visit = (directory: string, depth: number, parentRow: number | undefined): void => {
        directories.push(directory);
        const isComposingHere = composingDirectory === directory;
        if (isComposingHere)
            rows.push({ depth, directory, key: `create:${directory}`, kind: 'create', parentRow });
        const loaded = listing(directory);
        if (!loaded) return;
        const { entries } = loaded;
        for (const [index, entry] of entries.entries()) {
            const isPathExpanded = isExpanded(entry.path);
            const isRowExpanded =
                isPathExpanded && isFileTreeDirectory(entry, undefined, isPathExpanded);
            const rowIndex = rows.length;
            const row: FileTreeEntryRow = {
                depth,
                entry,
                index,
                isExpanded: isRowExpanded,
                key: entry.path,
                kind: 'entry',
                lastDescendant: rowIndex,
                parentRow,
                setSize: entries.length,
            };
            rows.push(row);
            if (isRowExpanded) {
                visit(entry.path, depth + 1, rowIndex);
                row.lastDescendant = rows.length - 1;
            }
        }
        if (!isComposingHere && entries.length === 0)
            rows.push({ depth, directory, key: `empty:${directory}`, kind: 'empty', parentRow });
        if (loaded.truncated)
            rows.push({
                count: entries.length,
                depth,
                directory,
                key: `truncated:${directory}`,
                kind: 'truncated',
                parentRow,
            });
    };

    visit(root, 0, undefined);
    return { directories, rows };
}

/**
 * The shared tree movements plus `afterRemoval`: where focus should land once the row (and its subtree) is gone, the
 * next row past the subtree, else the one before it.
 */
export type FileTreeNavigation = TreeNavigation | 'afterRemoval';

const fileTreeRowModel: TreeRowModel<FileTreeRow> = {
    depthOf: (row) => row.depth,
    // Only entry rows take focus; the inline create field and the empty/truncated notices are stepped over.
    isFocusable: (row) => row.kind === 'entry',
};

/**
 * Resolves a keyboard movement against the flattened model through the shared tree navigation.
 */
export function fileTreeNavigationTarget(
    rows: readonly FileTreeRow[],
    from: number,
    action: FileTreeNavigation,
): number | undefined {
    if (action !== 'afterRemoval')
        return treeNavigationTarget(rows, from, action, fileTreeRowModel);
    const row = rows.at(from);
    const subtreeEnd = row?.kind === 'entry' ? row.lastDescendant : from;
    return (
        treeNavigationTarget(rows, subtreeEnd, 'next', fileTreeRowModel) ??
        treeNavigationTarget(rows, from, 'previous', fileTreeRowModel)
    );
}

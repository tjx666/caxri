import { isPathAtOrBelow } from '@caxri/protocol';

/**
 * A Files tree selection, following VS Code's Explorer and Finder list views.
 *
 * - `paths` are every selected entry, in the order they were added (a range adds them in row order).
 * - `lead` is the row the user acted on last: it owns the roving Tab stop and is what Open and the activation guards
 *   compare against. It is always one of `paths`.
 * - `anchor` is where a Shift range starts. Plain clicks and Cmd-clicks move it; Shift-clicks keep it, so successive
 *   Shift-clicks resize one range around the same origin.
 */
export interface FileTreeSelection {
    anchor: string;
    lead: string;
    paths: readonly string[];
}

export function selectPath(path: string): FileTreeSelection {
    return { anchor: path, lead: path, paths: [path] };
}

/**
 * Selects several paths at once (restored or pasted entries), leading with `lead` when it is one of them.
 */
export function selectPaths(paths: readonly string[], lead = paths.at(-1)): FileTreeSelection {
    const unique = [...new Set(paths)];
    const resolvedLead = lead !== undefined && unique.includes(lead) ? lead : unique.at(-1);
    if (resolvedLead === undefined) throw new Error('A selection needs at least one path');
    return { anchor: unique[0], lead: resolvedLead, paths: unique };
}

/**
 * Cmd-click: adds `path` to the selection or removes it. Removing the last selected entry clears the selection.
 * Removing the lead hands it to the most recently added entry that is left, so the Tab stop stays on a selected row.
 */
export function toggleSelectedPath(
    current: FileTreeSelection | undefined,
    path: string,
): FileTreeSelection | undefined {
    if (!current) return selectPath(path);
    if (!current.paths.includes(path))
        return { anchor: path, lead: path, paths: [...current.paths, path] };
    const paths = current.paths.filter((selected) => selected !== path);
    const lead = paths.at(-1);
    if (lead === undefined) return undefined;
    return { anchor: path, lead: current.lead === path ? lead : current.lead, paths };
}

/**
 * Shift-click or Shift+Arrow: selects every visible row from the anchor through `path`, replacing the rest of the
 * selection. `visiblePaths` is the tree's row order; an anchor that is no longer visible (its folder collapsed, or it
 * was removed) starts the range at `path` itself.
 */
export function selectRange(
    current: FileTreeSelection | undefined,
    path: string,
    visiblePaths: readonly string[],
): FileTreeSelection {
    const anchor = current?.anchor ?? path;
    const from = visiblePaths.indexOf(anchor);
    const to = visiblePaths.indexOf(path);
    if (from === -1 || to === -1) return selectPath(path);
    return {
        anchor,
        lead: path,
        paths: visiblePaths.slice(Math.min(from, to), Math.max(from, to) + 1),
    };
}

/**
 * What a click on the row at `path` does to the selection. Cmd toggles the row and Shift selects a range; neither opens
 * the row, so building a selection never opens files or folds folders along the way. A plain click selects the row
 * alone and opens it. Ctrl is not a toggle: on macOS Ctrl-click is the secondary click that opens the row's menu.
 */
export function clickSelection(
    current: FileTreeSelection | undefined,
    path: string,
    modifiers: { metaKey: boolean; shiftKey: boolean },
    visiblePaths: readonly string[],
): { isActivating: boolean; selection: FileTreeSelection | undefined } {
    if (modifiers.shiftKey)
        return { isActivating: false, selection: selectRange(current, path, visiblePaths) };
    if (modifiers.metaKey)
        return { isActivating: false, selection: toggleSelectedPath(current, path) };
    return { isActivating: true, selection: selectPath(path) };
}

export function isPathInSelection(selection: FileTreeSelection | undefined, path: string): boolean {
    return selection?.paths.includes(path) ?? false;
}

/**
 * The entries a row action (Trash, Cut, Copy, drag) applies to: the whole selection when the row is part of it, as in
 * VS Code, or the row alone when it is not.
 */
export function selectionActionPaths(
    selection: FileTreeSelection | undefined,
    path: string,
): readonly string[] {
    return selection && selection.paths.length > 1 && selection.paths.includes(path)
        ? selection.paths
        : [path];
}

/**
 * The row that takes keyboard focus once `removed` (a trashed multi-selection) disappears: the first visible row after
 * the last removed one that survives, else the nearest surviving row above. A row inside a removed folder goes with
 * it.
 */
export function pathAfterRemoval(
    visiblePaths: readonly string[],
    removed: readonly string[],
): string | undefined {
    const isRemoved = (path: string): boolean =>
        removed.some((gone) => isPathAtOrBelow(path, gone));
    const last = Math.max(...removed.map((path) => visiblePaths.indexOf(path)));
    if (last === -1) return undefined;
    return (
        visiblePaths.slice(last + 1).find((path) => !isRemoved(path)) ??
        visiblePaths.slice(0, last).findLast((path) => !isRemoved(path))
    );
}

/**
 * Drops every path that sits inside another listed folder. A batch that moves or trashes a folder takes its contents
 * along, so acting on a selected child afterwards would only fail because it is already gone.
 */
export function outermostPaths(paths: readonly string[]): string[] {
    return paths.filter((path) =>
        paths.every((other) => other === path || !isPathAtOrBelow(path, other)),
    );
}

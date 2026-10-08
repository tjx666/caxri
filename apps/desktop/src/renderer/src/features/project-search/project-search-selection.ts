import type { FileSearchMatch, FileSearchMode } from '@caxri/protocol';

import type { NameSearchNode } from './project-search-tree';

/**
 * Identity of one result row, stable across refetches of the same query.
 *
 * Content results repeat a path once per hit, so the path alone is not unique; the line and column that follow it are
 * what the editor is asked to reveal, which makes them the same thing the row means.
 */
export function searchMatchKey(match: FileSearchMatch): string {
    return `${match.relativePath}:${match.line ?? 0}:${match.column ?? 0}`;
}

function collectNameTreeFiles(
    nodes: readonly NameSearchNode[],
    collected: FileSearchMatch[],
): FileSearchMatch[] {
    for (const node of nodes) {
        if (node.kind === 'file') collected.push(node.match);
        else collectNameTreeFiles(node.children, collected);
    }
    return collected;
}

/**
 * Every result the Up/Down keys can land on, in the order the left pane paints them.
 *
 * Reading the order back out of the rendered structure rather than out of the raw match list is what keeps the keyboard
 * and the eye together: name results are sorted into a tree (directories first), while content results keep the
 * Server's order grouped by file. Group headers are deliberately not selectable: they have no line to preview, and
 * stepping through a 40-hit file would otherwise cost an extra keystroke per file.
 */
export function selectableSearchMatches(
    mode: FileSearchMode,
    groups: ReadonlyMap<string, FileSearchMatch[]>,
    nameTree: readonly NameSearchNode[],
): FileSearchMatch[] {
    return mode === 'name' ? collectNameTreeFiles(nameTree, []) : groups.values().toArray().flat();
}

/**
 * Where Up/Down lands next. The ends hold rather than wrap: the list is driven from an input the user is still typing
 * in, and silently teleporting from the last result back to the first reads as a lost keystroke.
 */
export function nextSelectionIndex(count: number, current: number, delta: number): number {
    if (count === 0) return 0;
    return Math.max(0, Math.min(current + delta, count - 1));
}

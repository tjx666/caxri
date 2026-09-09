import type { WorkbenchRootOption } from '@caxri/protocol';

/**
 * Match contiguous branch/path text; fuzzy matching across a shared parent path surfaces unrelated worktrees.
 */
export function workbenchRootSearchScore(
    _value: string,
    search: string,
    keywords: string[] = [],
): number {
    const query = search.trim().toLocaleLowerCase();
    return keywords.some((keyword) => keyword.toLocaleLowerCase().includes(query)) ? 1 : 0;
}

/**
 * Current and main roots remain reachable without displacing the five newest linked worktrees.
 */
export function visibleWorkbenchRoots(
    roots: readonly WorkbenchRootOption[],
    projectId: string | undefined,
    shouldShowAll: boolean,
) {
    const current = projectId ? roots.find((root) => root.projectId === projectId) : undefined;
    const main = roots.find((root) => root.isMain);
    const recent = roots
        .filter((root) => root !== current && root !== main)
        .toSorted(
            (left, right) =>
                (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
                left.branch.localeCompare(right.branch) ||
                left.rootPath.localeCompare(right.rootPath),
        );
    return [
        ...(current ? [current] : []),
        ...(shouldShowAll ? recent : recent.slice(0, 5)),
        ...(main && main !== current ? [main] : []),
    ];
}

/**
 * Detached and duplicate branch labels need a directory hint; ordinary branch labels do not.
 */
export function workbenchRootLabel(
    root: WorkbenchRootOption,
    roots: readonly WorkbenchRootOption[],
) {
    return root.branch === 'detached' ||
        roots.some((other) => other.worktreeId !== root.worktreeId && other.branch === root.branch)
        ? `${root.branch === 'detached' ? 'Detached' : root.branch} · ${root.displayTitle}`
        : root.branch;
}

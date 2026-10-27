import type { WorkbenchRootOption } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * The worktrees this Session's own conversation named, most recently named first.
 *
 * The Server sets `conversationRank` only while the Session is still bound to the repository's main worktree, and only
 * for worktrees Git independently reported, so this is a display order, never an authorization.
 */
export function conversationWorkbenchRoots(roots: readonly WorkbenchRootOption[]) {
    return roots
        .filter((root) => root.conversationRank !== undefined)
        .toSorted((left, right) => (left.conversationRank ?? 0) - (right.conversationRank ?? 0));
}

/**
 * Current and main roots remain reachable without displacing the five newest linked worktrees.
 *
 * `excluded` carries the worktrees a leading group already renders, so a recommendation never appears twice.
 */
export function visibleWorkbenchRoots(
    roots: readonly WorkbenchRootOption[],
    projectId: string | undefined,
    shouldShowAll: boolean,
    excluded?: ReadonlySet<string>,
) {
    const current = projectId ? roots.find((root) => root.projectId === projectId) : undefined;
    const main = roots.find((root) => root.isMain);
    const recent = roots
        .filter((root) => root !== current && root !== main && !excluded?.has(root.worktreeId))
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
    t: Translate = translate,
) {
    return root.branch === 'detached' ||
        roots.some((other) => other.worktreeId !== root.worktreeId && other.branch === root.branch)
        ? `${root.branch === 'detached' ? t('statusBar.workbenchRoot.detached') : root.branch} · ${root.title}`
        : root.branch;
}

/**
 * The label the closed picker's trigger points at: the worktree this Session's conversation worked in most recently,
 * while the Session is still on its own root. Once the Session is on a linked worktree, that choice is the answer, so
 * nothing is suggested.
 */
export function conversationWorkbenchRootSuggestion(
    roots: readonly WorkbenchRootOption[],
    isWorktree: boolean,
    t: Translate = translate,
): string | undefined {
    if (isWorktree) return undefined;
    const first = conversationWorkbenchRoots(roots).at(0);
    return first ? workbenchRootLabel(first, roots, t) : undefined;
}

/**
 * The worktree a pull request on another branch can be opened in: the one root checked out on `branch`, other than the
 * Session's current root. `undefined` when no worktree has that branch, or when more than one does, because guessing
 * between two checkouts of the same branch would switch the Session somewhere the user did not pick.
 */
export function workbenchRootForBranch(
    roots: readonly WorkbenchRootOption[],
    branch: string,
    currentProjectId: string | undefined,
): WorkbenchRootOption | undefined {
    const matches = roots.filter(
        (root) =>
            root.branch === branch &&
            (currentProjectId === undefined || root.projectId !== currentProjectId),
    );
    return matches.length === 1 ? matches[0] : undefined;
}

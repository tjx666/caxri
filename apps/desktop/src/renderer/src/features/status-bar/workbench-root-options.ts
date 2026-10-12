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
        ? `${root.branch === 'detached' ? t('statusBar.workbenchRoot.detached') : root.branch} · ${root.displayTitle}`
        : root.branch;
}

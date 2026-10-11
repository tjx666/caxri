import type { GitRepositorySummary, GitSummary } from 'caxri';

import type { GitSourceControlMode } from './source-control-model';

function normalizeRepoPath(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

/**
 * Repository-relative paths of the submodules that already own a provider section of their own in this snapshot.
 *
 * The parent repository records a submodule as a single gitlink change, so the panel used to print the submodule twice
 * in a row: once as a `<name> · submodule` entry inside the parent's change list, and again as the submodule's own
 * repository section directly below it, with its branch and its real file changes. The gitlink row carried no detail
 * the section did not already carry better, so the parent's list drops it. A submodule the snapshot is not showing
 * separately, one outside the approved Project, keeps its ordinary gitlink row. See `hiddenGitlinkPaths` for the modes
 * this applies to.
 */
export function submodulePathsWithOwnSection(
    repo: GitRepositorySummary,
    repositories: readonly GitRepositorySummary[],
): ReadonlySet<string> {
    const root = normalizeRepoPath(repo.rootPath);
    const result = new Set<string>();
    for (const candidate of repositories) {
        if (candidate.kind !== 'submodule' || candidate.id === repo.id) continue;
        const candidateRoot = normalizeRepoPath(candidate.rootPath);
        if (candidateRoot.startsWith(`${root}/`)) result.add(candidateRoot.slice(root.length + 1));
    }
    return result;
}

/**
 * The gitlink rows a repository's list drops in the selected mode. Only Working mode hides them: there the submodule's
 * own section already shows the same uncommitted pointer move with its real file changes. Commit and Pull Request mode
 * show that submodule section's own commit or pull request, which says nothing about the pointer the parent's commit or
 * pull request moved, so hiding the gitlink row there made a pointer-only pull request read as having no changes.
 */
export function hiddenGitlinkPaths(
    mode: GitSourceControlMode,
    repo: GitRepositorySummary,
    repositories: readonly GitRepositorySummary[],
): ReadonlySet<string> {
    return mode === 'working' ? submodulePathsWithOwnSection(repo, repositories) : new Set();
}

/**
 * A repository's changed-file total with the gitlink rows the panel hides already subtracted, so the Git tab's badge
 * and the panel's own counts can never disagree about how many changes a Session has.
 */
export function visibleChangedFileCount(repo: GitRepositorySummary, summary: GitSummary): number {
    const hidden = submodulePathsWithOwnSection(repo, summary.repositories);
    if (hidden.size === 0) return repo.changedFileCount;
    return repo.changedFileCount - repo.files.filter((file) => hidden.has(file.path)).length;
}

import type { GitRepositorySummary } from 'caxri';

/**
 * The literal `git status --porcelain=v2 --branch` reports as the branch of a detached HEAD.
 */
const DETACHED_BRANCH = '(detached)';

interface RepoReference {
    /**
     * Visible text of the branch row.
     */
    label: string;
    /**
     * Leading phrase of the hover and accessible description.
     */
    summary: string;
    detached: boolean;
}

/**
 * Names what the repository has checked out. A detached HEAD is named by the tag or remote branch at that commit,
 * otherwise by its subject: a SHA identifies the commit but tells a reader nothing about which one it is.
 */
export function checkedOutReference(
    repo: Pick<GitRepositorySummary, 'branch' | 'detachedHead'>,
): RepoReference {
    if (repo.branch !== DETACHED_BRANCH)
        return { label: repo.branch, summary: repo.branch, detached: false };
    const head = repo.detachedHead;
    if (!head) return { label: 'Detached HEAD', summary: 'Detached HEAD', detached: true };
    return {
        label: head.reference ?? head.subject,
        summary: `${head.reference ? `Detached HEAD at ${head.reference}` : 'Detached HEAD'} · ${head.subject}`,
        detached: true,
    };
}

/**
 * Compact unsynced-commit counts, VS Code status-bar style; absent when the branch is level with its upstream.
 */
export function syncBadge(ahead: number, behind: number): string | undefined {
    const parts = [ahead > 0 && `↑${ahead}`, behind > 0 && `↓${behind}`].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
}

function slug(value: string): string {
    return value
        .toLowerCase()
        .replaceAll(/[^\da-z]+/g, '-')
        .replaceAll(/^-|-$/g, '');
}

/**
 * Whether a folder name is its branch name with path separators flattened (`fix/a-b` → `fix-a-b`). Worktree managers
 * often append a short hex disambiguator (`fix-a-b-6a2ba1f9`), which still counts as the same name.
 */
export function isNamedAfterBranch(folderName: string, branch: string): boolean {
    const folder = slug(folderName);
    const branchSlug = slug(branch);
    if (!branchSlug) return false;
    if (folder === branchSlug) return true;
    return (
        folder.startsWith(`${branchSlug}-`) &&
        /^[\da-f]{6,}$/.test(folder.slice(branchSlug.length + 1))
    );
}

export interface RepoBranchRow {
    /**
     * Visible text of the branch row; empty when the row would only repeat the repository name.
     */
    description: string;
    kind: 'branch' | 'commit';
    badge?: string;
    /**
     * Leading phrase of the hover and accessible description.
     */
    summary: string;
}

/**
 * A worktree folder is almost always named after its branch, so the branch row would only restate the header. It stays
 * when it adds something: a different branch, a detached commit, or unsynced commits.
 */
export function repoBranchRow(
    repo: Pick<GitRepositorySummary, 'ahead' | 'behind' | 'branch' | 'detachedHead' | 'name'>,
): RepoBranchRow {
    const reference = checkedOutReference(repo);
    const badge = reference.detached ? 'detached' : syncBadge(repo.ahead, repo.behind);
    const isRedundant =
        badge === undefined && !reference.detached && isNamedAfterBranch(repo.name, repo.branch);
    return {
        description: isRedundant ? '' : reference.label,
        kind: reference.detached ? 'commit' : 'branch',
        ...(badge && { badge }),
        summary: reference.summary,
    };
}

/**
 * Branch sync (`↑2 ↓1`) is not here: it describes the branch, so it rides on the branch row as `descriptionBadge`.
 */
export function formatRepoCountLabel(counts: {
    count: number;
    uncommittedCount: number;
    unpushedCommitCount: number;
}): string {
    return [
        counts.count > 0 ? `${counts.count}` : '',
        counts.unpushedCommitCount > 0 ? `${counts.unpushedCommitCount} unpushed` : '',
        counts.uncommittedCount > 0 ? `${counts.uncommittedCount} uncommitted` : '',
    ]
        .filter(Boolean)
        .map((part) => ` · ${part}`)
        .join('');
}

import type { GitSummary, ViewBadge } from 'caxri';

/**
 * Count the full working tree, including entries omitted from the rendered diff by filters or payload limits.
 */
export function workingTreeBadge(summary: GitSummary): ViewBadge | undefined {
    if (!summary.isRepository || summary.error) return undefined;
    const count = summary.repositories.reduce((total, repo) => total + repo.changedFileCount, 0);
    if (count === 0) return undefined;
    return {
        count,
        description: `${count} ${count === 1 ? 'change' : 'changes'}`,
        tone: 'neutral',
    };
}

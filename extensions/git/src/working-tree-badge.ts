import type { GitSummary, ViewBadge } from 'caxri';
import { l10n } from 'caxri';

import { visibleChangedFileCount } from './submodule-sections';

/**
 * Count the full working tree, including entries omitted from the rendered diff by filters or payload limits, but not
 * the gitlink rows the panel hides behind the submodule's own section, a badge that says 3 above a panel listing 2 is a
 * defect the user can see.
 */
export function workingTreeBadge(summary: GitSummary): ViewBadge | undefined {
    if (!summary.isRepository || summary.error) return undefined;
    const count = summary.repositories.reduce(
        (total, repo) => total + visibleChangedFileCount(repo, summary),
        0,
    );
    if (count === 0) return undefined;
    return {
        kind: 'count',
        count,
        description:
            count === 1
                ? l10n.t('{count} change', { count })
                : l10n.t('{count} changes', { count }),
    };
}

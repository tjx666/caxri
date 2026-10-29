import type { GitDiffTab } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';

/**
 * The multi-diff document feeds from the same `changedFileCount`-capped `files[]` the Git panel's sidebar truncation
 * banner reads (`git-repo-section.tsx`, `MAX_GIT_STATUS_FILES`); only the working-tree source is ever capped that way,
 * so a Pull Request's multi-diff list (bounded separately at a different limit) never shows this banner.
 */
export function shouldShowGitTruncationBanner(
    source: GitDiffTab['source'],
    isTruncated: boolean,
): boolean {
    return source === 'working' && isTruncated;
}

/**
 * Matches the sidebar's "Showing the first N of M changes" copy so the same truncated change set reads identically in
 * both surfaces.
 */
export function describeTruncatedGitChanges(
    visibleCount: number,
    totalCount: number,
    t: Translate,
): string {
    return t('editor.gitDiff.truncated', {
        visible: formatCount(visibleCount, t.locale),
        total: formatCount(totalCount, t.locale),
    });
}

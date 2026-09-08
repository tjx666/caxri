import type { ReactNode } from 'react';

import type { GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';

import { useSettings } from '../../stores/selectors';
import { describeHiddenGitDiffFiles, filterGitDiffFiles } from './git-diff-filter';
import { describeTruncatedGitChanges, shouldShowGitTruncationBanner } from './git-diff-truncation';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

export function GitChangesDiffList({
    changedFileCount,
    emptyLabel,
    files,
    renderFile,
    showExcluded,
    source,
    truncated = false,
}: {
    /**
     * Untruncated total behind `files`; required whenever `truncated` is true.
     */
    changedFileCount?: number;
    emptyLabel: string;
    files: readonly GitFileStatus[];
    renderFile: (file: GitFileStatus) => ReactNode;
    showExcluded: boolean;
    source: GitDiffTab['source'];
    truncated?: boolean;
}) {
    const settings = useSettings() ?? defaultAppSettings;
    const filtered = filterGitDiffFiles(files, settings['git.diffExclude'], showExcluded);
    if (files.length === 0) return <div className={emptyWorkClassName}>{emptyLabel}</div>;
    const showTruncationBanner = shouldShowGitTruncationBanner(source, truncated);
    return (
        <div className="git-multi-diff absolute inset-0 overflow-auto bg-background">
            {filtered.hiddenCount > 0 && filtered.files.length > 0 && (
                <div
                    role="status"
                    aria-live="polite"
                    className="git-multi-diff-excluded border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                >
                    {describeHiddenGitDiffFiles(filtered.hiddenCount, false)}
                </div>
            )}
            {showTruncationBanner && (
                <div
                    role="status"
                    aria-live="polite"
                    className="git-multi-diff-truncated sticky top-0 z-10 border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                >
                    {describeTruncatedGitChanges(files.length, changedFileCount ?? files.length)}
                </div>
            )}
            {filtered.files.length === 0 ? (
                <div className={emptyWorkClassName}>
                    {describeHiddenGitDiffFiles(filtered.hiddenCount, true, truncated)}
                </div>
            ) : (
                filtered.files.map(renderFile)
            )}
        </div>
    );
}

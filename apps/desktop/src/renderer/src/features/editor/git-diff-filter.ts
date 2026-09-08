import type { GitFileStatus } from '@caxri/protocol';
import { isGlobMatch } from '@caxri/utils';

export interface FilteredGitDiffFiles {
    files: readonly GitFileStatus[];
    hiddenCount: number;
}

export function filterGitDiffFiles(
    files: readonly GitFileStatus[],
    excludePatterns: Readonly<Record<string, boolean>>,
    isShowingExcluded: boolean,
): FilteredGitDiffFiles {
    if (isShowingExcluded) return { files, hiddenCount: 0 };
    const visibleFiles = files.filter((file) => !isGlobMatch(file.path, excludePatterns));
    return { files: visibleFiles, hiddenCount: files.length - visibleFiles.length };
}

export function describeHiddenGitDiffFiles(
    hiddenCount: number,
    areAllHidden: boolean,
    isTruncated = false,
): string {
    if (areAllHidden)
        return `All ${hiddenCount.toLocaleString()} ${isTruncated ? 'loaded ' : ''}changed ${hiddenCount === 1 ? 'file is' : 'files are'} hidden by Git diff exclusions.`;
    return `${hiddenCount.toLocaleString()} changed ${hiddenCount === 1 ? 'file is' : 'files are'} hidden by Git diff exclusions.`;
}

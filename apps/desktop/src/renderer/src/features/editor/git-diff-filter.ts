import type { GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { gitChangesDiffTabPath, gitPullRequestChangesDiffTabPath } from '@caxri/protocol';
import { isGlobMatch } from '@caxri/utils';

import type { Translate } from '../../i18n';

export interface FilteredGitDiffFiles {
    files: readonly GitFileStatus[];
    hiddenCount: number;
}

/**
 * The aggregate diff tab carries its own "show excluded" state in its resource path, so revealing hidden files is a tab
 * swap rather than a component-local flag: the choice then survives a reload and stays visible in the Session layout.
 * `commit` has no aggregate document, so only the two aggregate sources resolve to a path.
 */
export function gitChangesDiffTabPathFor(
    tab: Extract<GitDiffTab, { kind: 'changes' }>,
    isShowingExcluded: boolean,
): string {
    return tab.source === 'pull-request'
        ? gitPullRequestChangesDiffTabPath(tab.repositoryId, tab.repositoryName, isShowingExcluded)
        : gitChangesDiffTabPath(tab.repositoryId, tab.repositoryName, isShowingExcluded);
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
    isTruncated: boolean,
    t: Translate,
): string {
    const count = hiddenCount.toLocaleString();
    const isOne = hiddenCount === 1;
    if (areAllHidden) {
        if (isTruncated)
            return t(
                isOne ? 'editor.gitDiff.allHiddenLoadedOne' : 'editor.gitDiff.allHiddenLoadedOther',
                { count },
            );
        return t(isOne ? 'editor.gitDiff.allHiddenOne' : 'editor.gitDiff.allHiddenOther', {
            count,
        });
    }
    return t(isOne ? 'editor.gitDiff.hiddenOne' : 'editor.gitDiff.hiddenOther', { count });
}

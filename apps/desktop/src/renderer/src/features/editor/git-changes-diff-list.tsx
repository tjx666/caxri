import type { ReactNode } from 'react';
import { useId } from 'react';

import type { GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { openSettings } from '../../stores/dialogs';
import { useSettings } from '../../stores/selectors';
import { findPaneTabId } from '../workbench/pane-actions';
import { closeDocumentTabs, openEditorTab } from './document-commands';
import {
    describeHiddenGitDiffFiles,
    filterGitDiffFiles,
    gitChangesDiffTabPathFor,
} from './git-diff-filter';
import { describeTruncatedGitChanges, shouldShowGitTruncationBanner } from './git-diff-truncation';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const exclusionActionClassName = 'min-h-6 flex-none px-2 text-inherit';

/**
 * Reopens the same aggregate diff with exclusions revealed and drops the hiding occurrence, so the notice replaces the
 * tab the user is looking at instead of leaving two identically labelled `Changes:` tabs behind. The showing state
 * lives in the resource path, so this is the ordinary open-a-diff-tab path rather than a component-local override.
 */
function showExcludedGitDiffFiles(tabPath: string, showExcludedTabPath: string): void {
    const hidingTabId = findPaneTabId({ kind: 'file', path: tabPath });
    openEditorTab(showExcludedTabPath);
    if (!hidingTabId) return;
    // Fire-and-forget: a Git diff tab is virtual, so the close has no dirty-buffer confirmation to
    // report back, and `closeDocumentTabs` funnels any failure into its own toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void closeDocumentTabs([hidingTabId]);
}

/**
 * Both routes out of a hidden-file notice: reveal the files in place, or change which patterns hide them. `Show them`
 * and `Edit exclusions…` describe themselves through the notice they sit next to, which is what `aria-describedby`
 * carries to a screen reader.
 */
function GitDiffExclusionActions({
    noticeId,
    showExcludedTabPath,
    tabPath,
}: {
    noticeId: string;
    showExcludedTabPath: string;
    tabPath: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="git-multi-diff-excluded-actions flex flex-none items-center gap-1">
            <Button
                aria-describedby={noticeId}
                className={exclusionActionClassName}
                size="sm"
                variant="ghost"
                onClick={() => showExcludedGitDiffFiles(tabPath, showExcludedTabPath)}
            >
                {t('editor.gitDiff.showExcluded')}
            </Button>
            <Button
                aria-describedby={noticeId}
                className={exclusionActionClassName}
                size="sm"
                variant="ghost"
                onClick={() => openSettings('git-exclusions')}
            >
                {t('editor.gitDiff.editExclusions')}
            </Button>
        </div>
    );
}

export function GitChangesDiffList({
    changedFileCount,
    emptyLabel,
    files,
    renderFile,
    tab,
    tabPath,
    truncated = false,
}: {
    /**
     * Untruncated total behind `files`; required whenever `truncated` is true.
     */
    changedFileCount?: number;
    emptyLabel: string;
    files: readonly GitFileStatus[];
    renderFile: (file: GitFileStatus) => ReactNode;
    tab: Extract<GitDiffTab, { kind: 'changes' }>;
    /**
     * This tab's exact resource path, so revealing exclusions can retire the occurrence it replaces.
     */
    tabPath: string;
    truncated?: boolean;
}) {
    const { t } = useTranslation();
    const noticeId = useId();
    const settings = useSettings() ?? defaultAppSettings;
    const filtered = filterGitDiffFiles(
        files,
        settings['git.diffExclude'],
        tab.showExcluded === true,
    );
    if (files.length === 0) return <div className={emptyWorkClassName}>{emptyLabel}</div>;
    const showTruncationBanner = shouldShowGitTruncationBanner(tab.source, truncated);
    const showExcludedTabPath = gitChangesDiffTabPathFor(tab, true);
    return (
        <div className="git-multi-diff absolute inset-0 overflow-auto bg-background">
            {filtered.hiddenCount > 0 && filtered.files.length > 0 && (
                <div className="git-multi-diff-excluded flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted">
                    <span
                        id={noticeId}
                        role="status"
                        aria-live="polite"
                        className="min-w-0 flex-1 truncate"
                    >
                        {describeHiddenGitDiffFiles(filtered.hiddenCount, false, false, t)}
                    </span>
                    <GitDiffExclusionActions
                        noticeId={noticeId}
                        showExcludedTabPath={showExcludedTabPath}
                        tabPath={tabPath}
                    />
                </div>
            )}
            {showTruncationBanner && (
                <div
                    role="status"
                    aria-live="polite"
                    className="git-multi-diff-truncated sticky top-0 z-10 border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                >
                    {describeTruncatedGitChanges(files.length, changedFileCount ?? files.length, t)}
                </div>
            )}
            {filtered.files.length === 0 ? (
                <div className={emptyWorkClassName}>
                    <span id={noticeId} role="status" aria-live="polite">
                        {describeHiddenGitDiffFiles(filtered.hiddenCount, true, truncated, t)}
                    </span>
                    <GitDiffExclusionActions
                        noticeId={noticeId}
                        showExcludedTabPath={showExcludedTabPath}
                        tabPath={tabPath}
                    />
                </div>
            ) : (
                filtered.files.map(renderFile)
            )}
        </div>
    );
}

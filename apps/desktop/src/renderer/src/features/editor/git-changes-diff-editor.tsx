import { useState } from 'react';

import type { GitDiffDocument, GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { ChevronDown, ChevronRight, FileSymlink } from 'lucide-react';

import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { gitDecorationForFile } from '../../lib/git-decorations';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { describeFailure } from '../../stores/toasts';
import { usePaneViewSessionId } from '../workbench/pane-view-session';
import { openFile } from './document-commands';
import { GitChangesDiffList } from './git-changes-diff-list';
import { RESOLVED_GIT_DIFF_REASON_KEY } from './git-diff-resolution';
import { GitDiffSurface } from './git-diff-surface';
import {
    initialStackedEditorHeight,
    maxStackedEditorHeight,
    useNearMultiDiffViewport,
} from './git-multi-diff-viewport';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const gitMultiDiffPlaceholderClassName =
    'git-multi-diff-placeholder grid h-[360px] place-items-center text-muted text-[11px]';
const gitMultiDiffErrorClassName =
    'git-multi-diff-error grid place-items-center py-8 text-danger text-[11px]';

function GitChangesDiffResult({
    contentHeight,
    document,
    error,
    isError,
    onContentHeightChange,
    repositoryId,
    sessionId,
    source,
}: {
    contentHeight?: number;
    document?: GitDiffDocument | null;
    error: Error | null;
    isError: boolean;
    onContentHeightChange?: (height: number) => void;
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    const { t } = useTranslation();
    useToastOnQueryError(isError, error, t('editor.gitDiff.openFailed'));
    /**
     * A working-tree diff resolves to `null` when the change is committed, staged, or undone, routinely by an Agent
     * working in the background while the user is still reading this list. The row used to go blank under its own
     * heading, which reads as a rendering failure rather than as news about the file. Said in one line and without a
     * retry, because the list header above already refreshes every file at once. See issue #1004.
     */
    if (document === null)
        return (
            <div className={gitMultiDiffPlaceholderClassName}>
                {t(RESOLVED_GIT_DIFF_REASON_KEY)}
            </div>
        );
    if (isError)
        return (
            <div className={gitMultiDiffErrorClassName}>
                {describeFailure(error, t('editor.gitDiff.openFailed'))}
            </div>
        );
    if (!document)
        return (
            <LoadingSkeleton
                variant="document"
                className="git-multi-diff-placeholder h-[360px]"
                label={t('editor.gitDiff.loading')}
            />
        );
    return (
        <GitDiffSurface
            key={`${document.format}:${!document.original}:${!document.modified}`}
            stacked
            contentHeight={contentHeight}
            document={document}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source={source}
            sourceKey={source}
            onContentHeightChange={onContentHeightChange}
        />
    );
}

interface GitChangesDiffContentProperties {
    contentHeight?: number;
    onContentHeightChange?: (height: number) => void;
    path: string;
    repositoryId: string;
    sessionId: string;
}

function WorkingChangesDiffContent({
    contentHeight,
    onContentHeightChange,
    path,
    repositoryId,
    sessionId,
}: GitChangesDiffContentProperties) {
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery('git.diffDocument', {
        sessionId,
        repositoryId,
        path,
    });
    return (
        <GitChangesDiffResult
            contentHeight={contentHeight}
            document={document}
            error={error}
            isError={isError}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source="working"
            onContentHeightChange={onContentHeightChange}
        />
    );
}

function PullRequestChangesDiffContent({
    contentHeight,
    onContentHeightChange,
    path,
    repositoryId,
    sessionId,
}: GitChangesDiffContentProperties) {
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery('git.pullRequestDiffDocument', {
        sessionId,
        repositoryId,
        path,
    });
    return (
        <GitChangesDiffResult
            contentHeight={contentHeight}
            document={document}
            error={error}
            isError={isError}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source="pull-request"
            onContentHeightChange={onContentHeightChange}
        />
    );
}

function GitChangesDiffItem({
    file,
    repositoryId,
    repositoryRootPath,
    sessionId,
    source,
}: {
    file: GitFileStatus;
    repositoryId: string;
    repositoryRootPath?: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    const { t } = useTranslation();
    const { active, containerRef } = useNearMultiDiffViewport();
    const [expanded, setExpanded] = useState(true);
    /**
     * Remembered across virtualization: when the item scrolls out of the near-viewport window the editor unmounts, and
     * the placeholder must keep the measured height: collapsing back to the initial height would shift the outer scroll
     * position under the user.
     */
    const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
    const label = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    const fileName = pathBasename(file.path);
    const Content =
        source === 'pull-request' ? PullRequestChangesDiffContent : WorkingChangesDiffContent;
    return (
        <section ref={containerRef} className="git-multi-diff-item border-b border-border">
            <div className="git-multi-diff-heading sticky top-0 z-10 flex h-9 items-center gap-1 border-b border-border bg-surface pr-2 pl-1.5">
                <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[11px] font-semibold text-foreground"
                    aria-expanded={expanded}
                    title={label}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? (
                        <ChevronDown className="shrink-0" size={13} />
                    ) : (
                        <ChevronRight className="shrink-0" size={13} />
                    )}
                    <FileTypeIcon entry={{ kind: 'file', name: fileName }} />
                    <span className="truncate">{label}</span>
                </button>
                {repositoryRootPath && file.kind !== 'deleted' && (
                    <Tooltip content={t('editor.gitDiff.openFile')}>
                        <Button
                            className="git-multi-diff-open-file size-6"
                            size="icon"
                            variant="ghost"
                            aria-label={t('editor.gitDiff.openFileNamed', { path: file.path })}
                            // openFile (not openEditorTab): it reads the file first and only creates
                            // the tab on success, so a missing path toasts instead of leaving a tab
                            // stuck on "Loading file…".
                            onClick={() => {
                                // eslint-disable-next-line no-void -- intentional floating-promise discard; openFile toasts internally
                                void openFile(`${repositoryRootPath}/${file.path}`);
                            }}
                        >
                            <FileSymlink size={13} />
                        </Button>
                    </Tooltip>
                )}
                <GitFileStatusLetter
                    className="text-[11px]"
                    decoration={gitDecorationForFile(file)}
                />
            </div>
            {expanded &&
                (active ? (
                    <Content
                        contentHeight={contentHeight}
                        path={file.path}
                        repositoryId={repositoryId}
                        sessionId={sessionId}
                        onContentHeightChange={setContentHeight}
                    />
                ) : (
                    <div
                        className="git-multi-diff-placeholder"
                        style={{
                            height: Math.min(
                                contentHeight ?? initialStackedEditorHeight,
                                maxStackedEditorHeight,
                            ),
                        }}
                        aria-hidden="true"
                    />
                ))}
        </section>
    );
}

function ChangesDiffList({
    changedFileCount,
    emptyLabel,
    files,
    repositoryId,
    repositoryRootPath,
    sessionId,
    tab,
    tabPath,
    truncated = false,
}: {
    changedFileCount?: number;
    emptyLabel: string;
    files: readonly GitFileStatus[];
    repositoryId: string;
    repositoryRootPath?: string;
    sessionId: string;
    tab: Extract<GitDiffTab, { kind: 'changes' }>;
    tabPath: string;
    truncated?: boolean;
}) {
    return (
        <GitChangesDiffList
            changedFileCount={changedFileCount}
            emptyLabel={emptyLabel}
            files={files}
            tab={tab}
            tabPath={tabPath}
            truncated={truncated}
            renderFile={(file) => (
                <GitChangesDiffItem
                    key={file.path}
                    file={file}
                    repositoryId={repositoryId}
                    repositoryRootPath={repositoryRootPath}
                    sessionId={sessionId}
                    source={tab.source}
                />
            )}
        />
    );
}

function WorkingChangesDiffEditor({
    tab,
    tabPath,
}: {
    tab: Extract<GitDiffTab, { kind: 'changes' }>;
    tabPath: string;
}) {
    const { t } = useTranslation();
    const sessionId = usePaneViewSessionId();
    const {
        data: summary,
        isError,
        error,
    } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, t('editor.gitDiff.openChangesFailed'));
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, t('editor.gitDiff.openChangesFailed'))}
            </div>
        );
    if (!summary)
        return <LoadingSkeleton variant="document" label={t('editor.load.loadingChanges')} />;
    const repo = summary.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    if (!repo)
        return (
            <div className={emptyWorkClassName}>{t('editor.gitDiff.repositoryUnavailable')}</div>
        );
    return (
        <ChangesDiffList
            changedFileCount={repo.changedFileCount}
            emptyLabel={t('editor.gitDiff.workingTreeClean')}
            files={repo.files}
            repositoryId={repo.id}
            repositoryRootPath={repo.rootPath}
            sessionId={sessionId}
            tab={tab}
            tabPath={tabPath}
            truncated={repo.truncated}
        />
    );
}

function PullRequestChangesDiffEditor({
    tab,
    tabPath,
}: {
    tab: Extract<GitDiffTab, { kind: 'changes' }>;
    tabPath: string;
}) {
    const { t } = useTranslation();
    const sessionId = usePaneViewSessionId();
    const {
        data: pullRequest,
        isError,
        error,
    } = useCaxriQuery(
        'git.pullRequestChanges',
        { sessionId: sessionId ?? '', repositoryId: tab.repositoryId, refresh: 0 },
        { enabled: Boolean(sessionId) },
    );
    // Resolves the repository root for the per-file "Open File" action; PR changes carry paths only.
    const { data: summary } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    const repoRootPath = summary?.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)?.rootPath
        : undefined;
    useToastOnQueryError(isError, error, t('editor.gitDiff.openPullRequestChangesFailed'));
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, t('editor.gitDiff.openPullRequestChangesFailed'))}
            </div>
        );
    if (pullRequest === undefined)
        return (
            <LoadingSkeleton
                variant="document"
                label={t('editor.gitDiff.loadingPullRequestChanges')}
            />
        );
    if (pullRequest === null)
        return <div className={emptyWorkClassName}>{t('editor.gitDiff.noPullRequest')}</div>;
    return (
        <ChangesDiffList
            emptyLabel={t('editor.gitDiff.pullRequestEmpty')}
            files={pullRequest.files}
            repositoryId={pullRequest.repositoryId}
            repositoryRootPath={repoRootPath}
            sessionId={sessionId}
            tab={tab}
            tabPath={tabPath}
        />
    );
}

/**
 * The aggregate `Changes` tab: every changed file of the working tree or the branch's pull request, stacked.
 */
export function GitChangesDiffEditor({
    tab,
    tabPath,
}: {
    tab: Extract<GitDiffTab, { kind: 'changes' }>;
    tabPath: string;
}) {
    return tab.source === 'pull-request' ? (
        <PullRequestChangesDiffEditor tab={tab} tabPath={tabPath} />
    ) : (
        <WorkingChangesDiffEditor tab={tab} tabPath={tabPath} />
    );
}

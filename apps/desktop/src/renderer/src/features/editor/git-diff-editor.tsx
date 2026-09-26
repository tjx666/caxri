import { useState } from 'react';

import type { GitDiffDocument, GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { ChevronDown, ChevronRight, FileSymlink } from 'lucide-react';

import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { gitDecorationForFile } from '../../lib/git-decorations';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { useSessionById } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { usePaneViewSessionId } from '../workbench/pane-view-session';
import { openFile } from './document-commands';
import { EditorBreadcrumbs } from './editor-breadcrumbs';
import { EditorLoadFailure } from './editor-load-failure';
import { EditorPathBreadcrumbs } from './editor-path-breadcrumbs';
import { GitChangesDiffList } from './git-changes-diff-list';
import { didFocusDiffEditor } from './git-diff-actions';
import {
    RESOLVED_GIT_DIFF_REASON,
    resolvedGitDiffActionLabel,
    resolveNullGitDiffState,
} from './git-diff-resolution';
import { GitDiffSurface } from './git-diff-surface';
import {
    initialStackedEditorHeight,
    maxStackedEditorHeight,
    useNearMultiDiffViewport,
} from './git-multi-diff-viewport';
import { GitReviewSend } from './git-review-send';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const gitMultiDiffPlaceholderClassName =
    'git-multi-diff-placeholder grid h-[360px] place-items-center text-muted text-[11px]';
const gitMultiDiffErrorClassName =
    'git-multi-diff-error grid place-items-center py-8 text-danger text-[11px]';

function FileDiffResult({
    document,
    editorInstanceId,
    error,
    isError,
    isFetching,
    navigationKey,
    sessionId,
    tab,
    onRetry,
}: {
    document?: GitDiffDocument | null;
    editorInstanceId: string;
    error: Error | null;
    isError: boolean;
    isFetching: boolean;
    navigationKey: string;
    onRetry: () => void;
    sessionId?: string;
    tab: Extract<GitDiffTab, { kind: 'commit-file' | 'file' }>;
}) {
    const paneSession = useSessionById(sessionId);
    const { data: summary } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, 'Unable to open Git diff');
    if (!sessionId || document === null) return null;
    /**
     * A pull request or commit diff that fails to read used to leave the reason on screen with no way out, while the
     * working-tree path beside it offered `Check again`. The same read can succeed a moment later — the branch was
     * mid-fetch, the delivery CLI was not authenticated yet — so every diff tab now offers the retry. See issue #1004.
     */
    if (isError)
        return (
            <EditorLoadFailure
                actionLabel={resolvedGitDiffActionLabel(isFetching)}
                reason={describeFailure(error, 'Unable to open Git diff')}
                onAction={onRetry}
            />
        );
    if (!document) return <div className={emptyWorkClassName}>Loading diff…</div>;
    const renamedFrom =
        document.originalPath && document.originalPath !== document.path
            ? ` (renamed from ${document.originalPath})`
            : '';
    const repo = summary?.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    const absolutePath = resolveRepoFilePath(repo?.rootPath, document.path);
    const browseContext =
        repo && absolutePath && paneSession?.id === sessionId && paneSession.workbenchProjectId
            ? {
                  absolutePath,
                  projectRoot: repo.rootPath,
                  workbenchProjectId: paneSession.workbenchProjectId,
              }
            : undefined;
    return (
        <div className="git-file-diff absolute inset-0 flex flex-col overflow-hidden">
            {/* Same rail metrics as the file editor so switching surfaces does not move the first line of content. */}
            <div className="flex h-6 shrink-0 items-center overflow-hidden border-b border-border bg-surface">
                {browseContext ? (
                    <EditorBreadcrumbs
                        accessibilityLabel={`Diff breadcrumbs: ${document.path}${renamedFrom}`}
                        onEscapeToEditor={() => {
                            didFocusDiffEditor(navigationKey, editorInstanceId);
                        }}
                        paneId={editorInstanceId}
                        path={browseContext.absolutePath}
                        projectRoot={browseContext.projectRoot}
                        sessionId={sessionId}
                        workbenchProjectId={browseContext.workbenchProjectId}
                    />
                ) : (
                    <EditorPathBreadcrumbs
                        accessibilityLabel={`Diff breadcrumbs: ${document.path}${renamedFrom}`}
                        path={document.path}
                    />
                )}
            </div>
            <div className="relative min-h-0 flex-1">
                <GitDiffSurface
                    key={`${document.format}:${!document.original}:${!document.modified}`}
                    document={document}
                    editorInstanceId={editorInstanceId}
                    navigationKey={navigationKey}
                    repositoryId={tab.repositoryId}
                    sessionId={sessionId}
                    source={tab.source}
                    sourceKey={tab.source === 'commit' ? `commit:${tab.sha}` : tab.source}
                />
            </div>
        </div>
    );
}

function WorkingFileDiffEditor({
    editorInstanceId,
    navigationKey,
    tab,
}: {
    editorInstanceId: string;
    navigationKey: string;
    tab: Extract<GitDiffTab, { kind: 'file' }>;
}) {
    const sessionId = usePaneViewSessionId();
    const {
        data: document,
        isFetchedAfterMount,
        isFetching,
        isError,
        error,
        refetch,
    } = useCaxriQuery(
        'git.diffDocument',
        { sessionId: sessionId ?? '', repositoryId: tab.repositoryId, path: tab.path },
        { enabled: Boolean(sessionId), refetchOnMount: 'always' },
    );
    if (document === null) {
        // A failed read has to be reported from here rather than from `FileDiffResult`, which owns the toast for every
        // other failure on this path: a cached `null` returns above it, so the component that would announce the
        // failure is never mounted. Without this branch the tab keeps a retry that can never leave "Loading diff…".
        const nullState = resolveNullGitDiffState({ document, isError, isFetchedAfterMount });
        if (nullState === 'pending') return <div className={emptyWorkClassName}>Loading diff…</div>;
        const isFailed = nullState === 'failed';
        return (
            <EditorLoadFailure
                actionLabel={resolvedGitDiffActionLabel(isFetching)}
                reason={
                    isFailed
                        ? describeFailure(error, 'Unable to open Git diff')
                        : RESOLVED_GIT_DIFF_REASON
                }
                tone={isFailed ? 'failed' : 'interrupted'}
                onAction={() => {
                    // Fire-and-forget: the query's own state drives the label and the result, and a rejected refetch
                    // already surfaces through `isError` above.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    void refetch();
                }}
            />
        );
    }
    return (
        <FileDiffResult
            document={document}
            editorInstanceId={editorInstanceId}
            error={error}
            isError={isError}
            isFetching={isFetching}
            navigationKey={navigationKey}
            sessionId={sessionId}
            tab={tab}
            onRetry={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard; `isError` reports a rejected refetch
                void refetch();
            }}
        />
    );
}

function PullRequestFileDiffEditor({
    editorInstanceId,
    navigationKey,
    tab,
}: {
    editorInstanceId: string;
    navigationKey: string;
    tab: Extract<GitDiffTab, { kind: 'file' }>;
}) {
    const sessionId = usePaneViewSessionId();
    const {
        data: document,
        isError,
        isFetching,
        error,
        refetch,
    } = useCaxriQuery(
        'git.pullRequestDiffDocument',
        { sessionId: sessionId ?? '', repositoryId: tab.repositoryId, path: tab.path },
        { enabled: Boolean(sessionId) },
    );
    return (
        <FileDiffResult
            document={document}
            editorInstanceId={editorInstanceId}
            error={error}
            isError={isError}
            isFetching={isFetching}
            navigationKey={navigationKey}
            sessionId={sessionId}
            tab={tab}
            onRetry={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard; `isError` reports a rejected refetch
                void refetch();
            }}
        />
    );
}

function CommitFileDiffEditor({
    editorInstanceId,
    navigationKey,
    tab,
}: {
    editorInstanceId: string;
    navigationKey: string;
    tab: Extract<GitDiffTab, { kind: 'commit-file' }>;
}) {
    const sessionId = usePaneViewSessionId();
    const {
        data: document,
        isError,
        isFetching,
        error,
        refetch,
    } = useCaxriQuery(
        'git.commitDiffDocument',
        {
            sessionId: sessionId ?? '',
            repositoryId: tab.repositoryId,
            sha: tab.sha,
            path: tab.path,
        },
        // A commit is immutable under its sha, so the resolved diff never goes stale.
        { enabled: Boolean(sessionId), staleTime: Infinity },
    );
    return (
        <FileDiffResult
            document={document}
            editorInstanceId={editorInstanceId}
            error={error}
            isError={isError}
            isFetching={isFetching}
            navigationKey={navigationKey}
            sessionId={sessionId}
            tab={tab}
            onRetry={() => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard; `isError` reports a rejected refetch
                void refetch();
            }}
        />
    );
}

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
    useToastOnQueryError(isError, error, 'Unable to open Git diff');
    /**
     * A working-tree diff resolves to `null` when the change is committed, staged, or undone — routinely by an Agent
     * working in the background while the user is still reading this list. The row used to go blank under its own
     * heading, which reads as a rendering failure rather than as news about the file. Said in one line and without a
     * retry, because the list header above already refreshes every file at once. See issue #1004.
     */
    if (document === null)
        return <div className={gitMultiDiffPlaceholderClassName}>{RESOLVED_GIT_DIFF_REASON}</div>;
    if (isError)
        return (
            <div className={gitMultiDiffErrorClassName}>
                {describeFailure(error, 'Unable to open Git diff')}
            </div>
        );
    if (!document) return <div className={gitMultiDiffPlaceholderClassName}>Loading diff…</div>;
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
    const { active, containerRef } = useNearMultiDiffViewport();
    const [expanded, setExpanded] = useState(true);
    /**
     * Remembered across virtualization: when the item scrolls out of the near-viewport window the editor unmounts, and
     * the placeholder must keep the measured height — collapsing back to the initial height would shift the outer
     * scroll position under the user.
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
                    <Tooltip content="Open File">
                        <Button
                            className="git-multi-diff-open-file size-6"
                            size="icon"
                            variant="ghost"
                            aria-label={`Open ${file.path}`}
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
    useToastOnQueryError(isError, error, 'Unable to open Git changes');
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, 'Unable to open Git changes')}
            </div>
        );
    if (!summary) return <div className={emptyWorkClassName}>Loading changes…</div>;
    const repo = summary.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    if (!repo)
        return <div className={emptyWorkClassName}>Git repository is no longer available</div>;
    return (
        <ChangesDiffList
            changedFileCount={repo.changedFileCount}
            emptyLabel="Working tree clean."
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
    useToastOnQueryError(isError, error, 'Unable to open pull request changes');
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, 'Unable to open pull request changes')}
            </div>
        );
    if (pullRequest === undefined)
        return <div className={emptyWorkClassName}>Loading pull request changes…</div>;
    if (pullRequest === null)
        return <div className={emptyWorkClassName}>No pull request for this branch.</div>;
    return (
        <ChangesDiffList
            emptyLabel="Pull request has no file changes."
            files={pullRequest.files}
            repositoryId={pullRequest.repositoryId}
            repositoryRootPath={repoRootPath}
            sessionId={sessionId}
            tab={tab}
            tabPath={tabPath}
        />
    );
}

export function GitDiffEditor({
    paneId,
    tab,
    tabPath,
}: {
    paneId: string;
    tab: GitDiffTab;
    tabPath: string;
}) {
    const sessionId = usePaneViewSessionId();
    const content =
        tab.kind === 'commit-file' ? (
            <CommitFileDiffEditor editorInstanceId={paneId} navigationKey={tabPath} tab={tab} />
        ) : tab.kind === 'file' ? (
            tab.source === 'pull-request' ? (
                <PullRequestFileDiffEditor
                    editorInstanceId={paneId}
                    navigationKey={tabPath}
                    tab={tab}
                />
            ) : (
                <WorkingFileDiffEditor
                    editorInstanceId={paneId}
                    navigationKey={tabPath}
                    tab={tab}
                />
            )
        ) : tab.source === 'pull-request' ? (
            <PullRequestChangesDiffEditor tab={tab} tabPath={tabPath} />
        ) : (
            <WorkingChangesDiffEditor tab={tab} tabPath={tabPath} />
        );
    return (
        <div className="relative h-full w-full">
            {content}
            {sessionId && <GitReviewSend sessionId={sessionId} repositoryId={tab.repositoryId} />}
        </div>
    );
}

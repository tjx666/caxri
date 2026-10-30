import type { GitDiffDocument, GitDiffTab } from '@caxri/protocol';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { useTranslation } from '../../../i18n';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../../lib/repository-file-path';
import { useCaxriQuery, useToastOnQueryError } from '../../../queries/client';
import { useSessionById } from '../../../stores/selectors';
import { describeFailure } from '../../../stores/toasts';
import { usePaneViewSessionId } from '../../workbench/pane-view-session';
import { EditorBreadcrumbs } from '../editor-breadcrumbs';
import { EditorLoadFailure } from '../editor-load-failure';
import { EditorPathBreadcrumbs } from '../editor-path-breadcrumbs';
import { didFocusDiffEditor } from './diff-actions';
import {
    RESOLVED_GIT_DIFF_REASON_KEY,
    resolvedGitDiffActionLabel,
    resolveNullGitDiffState,
} from './diff-resolution';
import { GitChangesDiffEditor } from './git-changes-diff-editor';
import { GitDiffSurface } from './git-diff-surface';

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
    const { t } = useTranslation();
    const paneSession = useSessionById(sessionId);
    const { data: summary } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, t('editor.gitDiff.openFailed'));
    if (!sessionId || document === null) return null;
    /**
     * A pull request or commit diff that fails to read used to leave the reason on screen with no way out, while the
     * working-tree path beside it offered `Check again`. The same read can succeed a moment later: the branch was
     * mid-fetch, the delivery CLI was not authenticated yet, so every diff tab now offers the retry. See issue #1004.
     */
    if (isError)
        return (
            <EditorLoadFailure
                actionLabel={t(resolvedGitDiffActionLabel(isFetching))}
                reason={describeFailure(error, t('editor.gitDiff.openFailed'), t)}
                onAction={onRetry}
            />
        );
    if (!document)
        return <LoadingSkeleton variant="document" label={t('editor.gitDiff.loading')} />;
    const breadcrumbsLabel =
        document.originalPath && document.originalPath !== document.path
            ? t('editor.breadcrumbs.diffLabelRenamed', {
                  path: document.path,
                  originalPath: document.originalPath,
              })
            : t('editor.breadcrumbs.diffLabel', { path: document.path });
    const repo = summary?.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    const absolutePath = resolveRepoFilePath(repo?.rootPath, document.path);
    const browseContext =
        repo && absolutePath && paneSession?.id === sessionId && paneSession.workbenchRootProjectId
            ? {
                  absolutePath,
                  projectRoot: repo.rootPath,
                  workbenchRootProjectId: paneSession.workbenchRootProjectId,
              }
            : undefined;
    return (
        <div className="git-file-diff absolute inset-0 flex flex-col overflow-hidden">
            {/* Same rail metrics as the file editor so switching surfaces does not move the first line of content. */}
            <div className="flex h-6 shrink-0 items-center overflow-hidden border-b border-border bg-surface">
                {browseContext ? (
                    <EditorBreadcrumbs
                        accessibilityLabel={breadcrumbsLabel}
                        onEscapeToEditor={() => {
                            didFocusDiffEditor(navigationKey, editorInstanceId);
                        }}
                        paneId={editorInstanceId}
                        path={browseContext.absolutePath}
                        projectRoot={browseContext.projectRoot}
                        sessionId={sessionId}
                        workbenchRootProjectId={browseContext.workbenchRootProjectId}
                    />
                ) : (
                    <EditorPathBreadcrumbs
                        accessibilityLabel={breadcrumbsLabel}
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
    const { t } = useTranslation();
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
        if (nullState === 'pending')
            return <LoadingSkeleton variant="document" label={t('editor.gitDiff.loading')} />;
        const isFailed = nullState === 'failed';
        return (
            <EditorLoadFailure
                actionLabel={t(resolvedGitDiffActionLabel(isFetching))}
                reason={
                    isFailed
                        ? describeFailure(error, t('editor.gitDiff.openFailed'), t)
                        : t(RESOLVED_GIT_DIFF_REASON_KEY)
                }
                tone={isFailed ? 'failed' : 'interrupted'}
                onAction={() => {
                    // Fire-and-forget: the query's own state drives the label and the result, and a rejected refetch
                    // already surfaces through `isError` above.
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
                void refetch();
            }}
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
        ) : (
            <GitChangesDiffEditor tab={tab} tabPath={tabPath} />
        );
    return <div className="relative h-full w-full">{content}</div>;
}

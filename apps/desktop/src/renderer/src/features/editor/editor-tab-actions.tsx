import type { GitDiffTab } from '@caxri/protocol';
import {
    gitCommitFileDiffTabPath,
    gitPullRequestFileDiffTabPath,
    isExternalEditorTabPath,
    parseGitDiffTab,
} from '@caxri/protocol';
import { ArrowDown, ArrowUp, FileSymlink, GitCommitHorizontal, GitPullRequest } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';
import { useCaxriQuery } from '../../queries/client';
import { previewTabSwitch } from '../preview/preview-commands';
import { PreviewTabAction } from '../preview/preview-tab-action';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { openEditorTab, openFileForSession } from './document-commands';
import {
    didNavigateDiffEditor,
    getDiffEditorFileSelection,
    useDiffEditorActionState,
} from './git-diff-actions';
import { GitDiffViewOptions } from './git-diff-view-options';
import { GitReviewSend } from './git-review-send';

/**
 * Fixed actions for the active file or single-file Git diff. The optional `git.fileHead` annotation already resolves
 * the innermost authorized repository, so the Renderer never guesses repository ownership from path prefixes.
 */
export function EditorTabActions({ path, paneId }: { paneId?: string; path: string }) {
    const gitDiffTab = parseGitDiffTab(path);
    const session = usePaneViewSession();
    if (gitDiffTab) {
        return (
            <>
                {gitDiffTab.kind !== 'changes' && (
                    <GitDiffTabActions paneId={paneId} tab={gitDiffTab} tabPath={path} />
                )}
                {/*
                 * Lives here instead of an overlay on the diff surface itself so it is discoverable the same way as
                 * every other diff tab action, and reachable for all three diff kinds (single file, Open Changes, and
                 * commit file), not just the ones `GitDiffTabActions` covers.
                 */}
                {session && (
                    <GitReviewSend sessionId={session.id} repositoryId={gitDiffTab.repositoryId} />
                )}
                <GitDiffViewOptions stacked={gitDiffTab.kind === 'changes'} />
            </>
        );
    }
    const tabSwitch = previewTabSwitch(path);
    return (
        <>
            {tabSwitch && <PreviewTabAction tabSwitch={tabSwitch} />}
            {/* An external document belongs to no Project repository, so it has no Git history to open. */}
            {!isExternalEditorTabPath(path) && <FileEditorTabActions path={path} />}
        </>
    );
}

function FileEditorTabActions({ path }: { path: string }) {
    const session = usePaneViewSession();
    const headQuery = useCaxriQuery(
        'git.fileHead',
        { sessionId: session?.id ?? '', path },
        { enabled: Boolean(session), retry: false, staleTime: 60_000 },
    );
    const head = headQuery.data;
    if (!session || head === null || headQuery.isError) return null;
    /**
     * Keep the tab rail at its final width while the optional file-history annotation loads.
     */
    if (!head) return <span aria-hidden="true" className="block w-14 flex-none" />;
    return (
        <>
            <Tooltip content="Open Last Commit Changes">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Open Last Commit Changes"
                    onClick={() =>
                        openEditorTab(
                            gitCommitFileDiffTabPath(head.repositoryId, head.sha, head.path),
                        )
                    }
                >
                    <GitCommitHorizontal aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
            <Tooltip content="Open Pull Request Changes">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Open Pull Request Changes"
                    onClick={() =>
                        openEditorTab(gitPullRequestFileDiffTabPath(head.repositoryId, head.path))
                    }
                >
                    <GitPullRequest aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
        </>
    );
}

function GitDiffTabActions({
    paneId,
    tab,
    tabPath,
}: {
    paneId?: string;
    tab: Extract<GitDiffTab, { kind: 'commit-file' | 'file' }>;
    tabPath: string;
}) {
    const session = usePaneViewSession();
    const actionState = useDiffEditorActionState(tabPath, paneId);
    const summary = useCaxriQuery(
        'git.summary',
        { sessionId: session?.id ?? '' },
        { enabled: Boolean(session), retry: false, staleTime: 60_000 },
    ).data;
    const repo = summary?.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    const currentFile = repo?.files.find((file) => file.path === tab.path);
    const isDeleted = currentFile?.kind === 'deleted';
    const openPath = resolveRepoFilePath(repo?.rootPath, tab.path);
    const canOpen = Boolean(session && openPath && !isDeleted);
    return (
        <>
            <Tooltip content="Previous Change">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Previous Change"
                    disabled={!actionState.hasChanges}
                    onClick={() => {
                        if (paneId) didNavigateDiffEditor(tabPath, paneId, 'previous');
                    }}
                >
                    <ArrowUp aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
            <Tooltip content="Next Change">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Next Change"
                    disabled={!actionState.hasChanges}
                    onClick={() => {
                        if (paneId) didNavigateDiffEditor(tabPath, paneId, 'next');
                    }}
                >
                    <ArrowDown aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
            <Tooltip content={isDeleted ? 'File was deleted' : 'Open Current File'}>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={isDeleted ? 'File was deleted' : 'Open Current File'}
                    disabled={!canOpen}
                    onClick={() => {
                        if (!session || !openPath) return;
                        // Carry the reader's place across: opening the file at line 1 loses the hunk they were on, and
                        // the modified side already numbers lines the way the opened file does. A commit or
                        // pull-request tab shows a past revision, so the line can drift against the checkout; issue
                        // #1147 still prefers landing near the hunk over always landing on line 1.
                        const selection = paneId
                            ? getDiffEditorFileSelection(tabPath, paneId)
                            : undefined;
                        // eslint-disable-next-line no-void -- openFileForSession reports failures through tryCommand
                        void openFileForSession(session.id, openPath, {
                            focus: true,
                            paneId,
                            ...(selection && {
                                location: {
                                    mode: 'caret' as const,
                                    line: selection.line,
                                    column: selection.column,
                                },
                            }),
                        });
                    }}
                >
                    <FileSymlink aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
        </>
    );
}

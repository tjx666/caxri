import type { GitDiffTab } from '@caxri/protocol';
import {
    gitCommitFileDiffTabPath,
    gitPullRequestFileDiffTabPath,
    parseGitDiffTab,
} from '@caxri/protocol';
import { ArrowDown, ArrowUp, FileSymlink, GitCommitHorizontal, GitPullRequest } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../lib/repository-file-path';
import { useCaxriQuery } from '../../queries/client';
import { useSelectedSession } from '../../stores/selectors';
import { openEditorTab, openFileForSession } from './document-actions';
import { didNavigateDiffEditor, useDiffEditorActionState } from './git-diff-actions';
import { GitDiffViewOptions } from './git-diff-view-options';

/**
 * Fixed actions for the active file or single-file Git diff. The optional `git.fileHead` annotation already resolves
 * the innermost authorized repository, so the Renderer never guesses repository ownership from path prefixes.
 */
export function EditorTabActions({ path, paneId }: { paneId?: string; path: string }) {
    const gitDiffTab = parseGitDiffTab(path);
    if (gitDiffTab) {
        return (
            <>
                {gitDiffTab.kind !== 'changes' && (
                    <GitDiffTabActions paneId={paneId} tab={gitDiffTab} tabPath={path} />
                )}
                <GitDiffViewOptions stacked={gitDiffTab.kind === 'changes'} />
            </>
        );
    }
    return <FileEditorTabActions path={path} />;
}

function FileEditorTabActions({ path }: { path: string }) {
    const session = useSelectedSession();
    const head = useCaxriQuery(
        'git.fileHead',
        { sessionId: session?.id ?? '', path },
        { enabled: Boolean(session), retry: false, staleTime: 60_000 },
    ).data;
    if (!head) return null;
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
    const session = useSelectedSession();
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
                        // eslint-disable-next-line no-void -- openFileForSession reports failures through tryCommand
                        void openFileForSession(session.id, openPath, {
                            focus: true,
                            paneId,
                        });
                    }}
                >
                    <FileSymlink aria-hidden="true" size={14} />
                </Button>
            </Tooltip>
        </>
    );
}

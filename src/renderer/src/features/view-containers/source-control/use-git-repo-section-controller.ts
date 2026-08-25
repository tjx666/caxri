import { useState } from 'react';

import type { GitDiffTab } from '@shared/git-diff';
import type {
    GitCommitDetails,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary,
} from '@shared/types';
import { useQuery } from '@tanstack/react-query';

import { useShouldReduceMotion } from '@/hooks/use-should-reduce-motion';

import { useToastOnQueryError } from '../../../queries/client';
import { useControlledView, useSourceControlClient } from '../controlled-view-context';
import { controlledViewQueryKey } from '../view-operation-client';
import {
    openGitChangesDiff,
    openGitCommitFileDiff,
    openGitFileDiff,
    openPullRequestChangesDiff,
    openPullRequestFileDiff,
} from './git-diff-actions';
import {
    gitRepoDisplayedCount,
    gitRepoEmptyMessage,
    gitRepoFilesForMode,
    selectedGitRepoPath,
} from './git-repo-section-state';
import type { GitFileTreeNode } from './git-tree';
import { buildGitFileTree } from './git-tree';
import { discardAllChanges, discardFileChanges } from './git-working-tree-actions';
import type { SourceControlViewMode } from './source-control-state';

function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- Git action helpers report failures through tryCommand
    void promise;
}

interface GitRepoDiffActionContext {
    headSha: string | undefined;
    mode: SourceControlViewMode;
    repositoryId: string;
    repositoryName: string;
}

interface GitRepoDiffActionDependencies {
    openCommitFile: typeof openGitCommitFileDiff;
    openPullRequestChanges: typeof openPullRequestChangesDiff;
    openPullRequestFile: typeof openPullRequestFileDiff;
    openWorkingChanges: typeof openGitChangesDiff;
    openWorkingFile: typeof openGitFileDiff;
}

export interface GitRepoSectionProperties {
    activeDiff?: GitDiffTab;
    expanded: boolean;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    flashed: boolean;
    mode: SourceControlViewMode;
    onExpandedChange: (isExpanded: boolean) => void;
    onFocusRepository: (repoId: string) => void;
    pullRequestRefresh: number;
    repository: GitRepositorySummary;
    sessionId: string;
    setDirectoryExpanded: (key: string, isExpanded: boolean) => void;
    submodulesByPath: ReadonlyMap<string, GitRepositorySummary>;
}

export interface GitRepoSectionController extends GitRepoSectionProperties {
    changesExpanded: boolean;
    discardAll: () => void;
    discardFile: (file: GitFileStatus) => void;
    displayedCount: number;
    emptyMessage: string;
    files: GitFileStatus[];
    latestCommit: GitCommitDetails | undefined;
    openChanges: () => void;
    openFile: (path: string) => void;
    pullRequest: GitPullRequestChanges | null | undefined;
    reduceMotion: boolean;
    selectedPath: string | undefined;
    toggleChangesExpanded: () => void;
    toggleExpanded: () => void;
    buildTreeNodes: () => GitFileTreeNode[];
}

export function createGitRepoDiffActions(
    context: GitRepoDiffActionContext,
    dependencies: GitRepoDiffActionDependencies,
): Pick<GitRepoSectionController, 'openChanges' | 'openFile'> {
    return {
        openChanges: () => {
            if (context.mode === 'pull-request') {
                dependencies.openPullRequestChanges(context.repositoryId, context.repositoryName);
            } else if (context.mode === 'working') {
                dependencies.openWorkingChanges(context.repositoryId, context.repositoryName);
            }
        },
        openFile: (path) => {
            if (context.mode === 'pull-request') {
                dependencies.openPullRequestFile(context.repositoryId, path);
            } else if (context.mode === 'commit') {
                if (context.headSha)
                    dependencies.openCommitFile(context.repositoryId, context.headSha, path);
            } else {
                dependencies.openWorkingFile(context.repositoryId, path);
            }
        },
    };
}

/**
 * Owns repository-specific queries, mode projection, and action sequencing. The repository section view receives one
 * render-ready result while Runtime remains the authority behind every Git action and query.
 */
export function useGitRepoSectionController(
    properties: GitRepoSectionProperties,
): GitRepoSectionController {
    const { viewId } = useControlledView();
    const client = useSourceControlClient();
    const {
        activeDiff,
        expanded,
        mode,
        onExpandedChange,
        pullRequestRefresh,
        repository,
        sessionId,
    } = properties;
    // Local like the Commits disclosure in `commit-history.tsx`; not persisted across Session switches.
    const [changesExpanded, setChangesExpanded] = useState(true);
    const reduceMotion = useShouldReduceMotion();
    const pullRequestArguments = {
        repositoryId: repository.id,
        refresh: pullRequestRefresh,
    };
    const pullRequestQuery = useQuery({
        queryKey: controlledViewQueryKey(viewId, 'git.pullRequestChanges', pullRequestArguments),
        queryFn: ({ signal }) =>
            client.pullRequestChanges(repository.id, pullRequestRefresh, signal),
        enabled: mode === 'pull-request',
    });
    useToastOnQueryError(
        pullRequestQuery.isError,
        pullRequestQuery.error,
        'Pull request refresh failed',
    );
    const pullRequest = mode === 'pull-request' ? pullRequestQuery.data : undefined;
    const headSha = repository.head;
    const latestCommitArguments = {
        repositoryId: repository.id,
        // Placeholder satisfies the params schema while the query is disabled without a HEAD.
        sha: headSha ?? '0000000000000000000000000000000000000000',
    };
    const latestCommitQuery = useQuery({
        queryKey: controlledViewQueryKey(viewId, 'git.commitDetails', latestCommitArguments),
        queryFn: ({ signal }) => client.commitDetails(latestCommitArguments, signal),
        enabled: mode === 'commit' && Boolean(headSha),
    });
    useToastOnQueryError(
        latestCommitQuery.isError,
        latestCommitQuery.error,
        'Last commit load failed',
    );
    const latestCommit = mode === 'commit' ? latestCommitQuery.data : undefined;
    const files = gitRepoFilesForMode(mode, repository.files, latestCommit, pullRequest);
    /**
     * Working-tree count uses `changedFileCount`: Runtime may truncate `files[]` while this authoritative count keeps
     * reporting the complete change set, matching the Status Bar projection.
     */
    const displayedCount = gitRepoDisplayedCount(mode, repository.changedFileCount, files);
    const selectedPath = selectedGitRepoPath(mode, activeDiff, repository.id, headSha);
    const emptyMessage = gitRepoEmptyMessage({
        headSha,
        latestCommit,
        latestCommitError: latestCommitQuery.isError,
        mode,
        pullRequest,
        pullRequestError: pullRequestQuery.isError,
    });
    const diffActions = createGitRepoDiffActions(
        {
            headSha,
            mode,
            repositoryId: repository.id,
            repositoryName: repository.name,
        },
        {
            openCommitFile: openGitCommitFileDiff,
            openPullRequestChanges: openPullRequestChangesDiff,
            openPullRequestFile: openPullRequestFileDiff,
            openWorkingChanges: openGitChangesDiff,
            openWorkingFile: openGitFileDiff,
        },
    );
    return {
        ...properties,
        buildTreeNodes: () => buildGitFileTree(files),
        changesExpanded,
        discardAll: () => discard(discardAllChanges(client, sessionId, repository)),
        discardFile: (file) => discard(discardFileChanges(client, sessionId, repository, file)),
        displayedCount,
        emptyMessage,
        files,
        latestCommit,
        ...diffActions,
        pullRequest,
        reduceMotion,
        selectedPath,
        toggleChangesExpanded: () => setChangesExpanded((value) => !value),
        toggleExpanded: () => onExpandedChange(!expanded),
    };
}

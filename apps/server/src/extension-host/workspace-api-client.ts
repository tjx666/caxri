import type {
    CancellationToken,
    CaxriApi,
    GitCommitDetails,
    GitCommitPage,
    GitPullRequestChanges,
    GitSummary,
} from 'caxri';

import type { ExtensionWorkspaceOperation } from './protocol';

export type WorkspaceApiRequest = <Result>(
    operation: ExtensionWorkspaceOperation,
    arguments_: unknown,
    token?: CancellationToken,
) => Promise<Result>;

export function createWorkspaceApiClient(
    request: WorkspaceApiRequest,
): Pick<CaxriApi['workspace'], 'git'> {
    return {
        git: Object.freeze({
            summary: (refresh = 0, token?: CancellationToken) =>
                request<GitSummary>('git.summary', { refresh }, token),
            sync: async (repoId: string, token?: CancellationToken) => {
                await request<null>('git.sync', { repositoryId: repoId }, token);
            },
            discard: (
                repoId: Parameters<CaxriApi['workspace']['git']['discard']>[0],
                scope: Parameters<CaxriApi['workspace']['git']['discard']>[1],
                token?: CancellationToken,
            ) =>
                request<null | { canceled: true }>(
                    'git.discard',
                    {
                        repositoryId: repoId,
                        scope,
                    },
                    token,
                ),
            mergePullRequest: (
                repoId: string,
                pullRequest: { number: number; headSha: string },
                token?: CancellationToken,
            ) =>
                request<{ method: 'squash' | 'merge' | 'rebase'; url: string }>(
                    'git.mergePullRequest',
                    {
                        repositoryId: repoId,
                        number: pullRequest.number,
                        headSha: pullRequest.headSha,
                    },
                    token,
                ),
            pullRequestChanges: (repoId: string, refresh = 0, token?: CancellationToken) =>
                request<GitPullRequestChanges | null>(
                    'git.pullRequestChanges',
                    {
                        repositoryId: repoId,
                        refresh,
                    },
                    token,
                ),
            commits: (
                options: Parameters<CaxriApi['workspace']['git']['commits']>[0],
                token?: CancellationToken,
            ) => request<GitCommitPage>('git.commits', options, token),
            commitDetails: (
                options: Parameters<CaxriApi['workspace']['git']['commitDetails']>[0],
                token?: CancellationToken,
            ) => request<GitCommitDetails>('git.commitDetails', options, token),
            remoteHost: (repoId: string, token?: CancellationToken) =>
                request<string | null>('git.remoteHost', { repositoryId: repoId }, token),
        }),
    };
}

import type {
    CancellationToken,
    CaxriApi,
    FileEntry,
    FileMutationOperation,
    FileSearchResult,
    GitCommitDetails,
    GitCommitPage,
    GitPullRequestChanges,
    GitSummary,
    MovedFileEntry,
    MutableFileEntry,
} from 'caxri';

import type { ExtensionWorkspaceOperation } from '../shared/extension-host-protocol';

export type WorkspaceApiRequest = <Result>(
    operation: ExtensionWorkspaceOperation,
    arguments_: unknown,
    token?: CancellationToken,
) => Promise<Result>;

export function createWorkspaceApiClient(
    request: WorkspaceApiRequest,
): Pick<CaxriApi['workspace'], 'fs' | 'git'> {
    return {
        fs: Object.freeze({
            list: (directory?: string, token?: CancellationToken) =>
                request<FileEntry[]>(
                    'files.list',
                    {
                        ...(directory !== undefined && { directory }),
                    },
                    token,
                ),
            search: (
                options: Parameters<CaxriApi['workspace']['fs']['search']>[0],
                token?: CancellationToken,
            ) => request<FileSearchResult>('files.search', options, token),
            create: (
                options: Parameters<CaxriApi['workspace']['fs']['create']>[0],
                token?: CancellationToken,
            ) => request<MutableFileEntry>('files.create', options, token),
            copy: (path: string, directory: string, token?: CancellationToken) =>
                request<MutableFileEntry>('files.copy', { directory, path }, token),
            rename: (
                options: Parameters<CaxriApi['workspace']['fs']['rename']>[0],
                token?: CancellationToken,
            ) => request<MovedFileEntry>('files.rename', options, token),
            move: (
                options: Parameters<CaxriApi['workspace']['fs']['move']>[0],
                token?: CancellationToken,
            ) => request<MovedFileEntry>('files.move', options, token),
            getOperation: (operationId: string, token?: CancellationToken) =>
                request<FileMutationOperation | null>(
                    'files.operation.get',
                    { operationId },
                    token,
                ),
            listOperations: (token?: CancellationToken) =>
                request<FileMutationOperation[]>('files.operation.list', {}, token),
            cancelOperation: (operationId: string, token?: CancellationToken) =>
                request<FileMutationOperation>('files.operation.cancel', { operationId }, token),
            acknowledgeOperation: async (operationId: string, token?: CancellationToken) => {
                await request<null>('files.operation.acknowledge', { operationId }, token);
            },
            trash: (
                path: string,
                options?: Parameters<CaxriApi['workspace']['fs']['trash']>[1],
                token?: CancellationToken,
            ) =>
                request<MutableFileEntry | { canceled: true }>(
                    'files.trash',
                    { path, ...options },
                    token,
                ),
            reveal: async (path: string, token?: CancellationToken) => {
                await request<unknown>('files.reveal', { path }, token);
            },
        }),
        git: Object.freeze({
            summary: (refresh = 0, token?: CancellationToken) =>
                request<GitSummary>('git.summary', { refresh }, token),
            sync: async (repoId: string, token?: CancellationToken) => {
                await request<null>('git.sync', { repositoryId: repoId }, token);
            },
            discard: (
                repo: Parameters<CaxriApi['workspace']['git']['discard']>[0],
                scope: Parameters<CaxriApi['workspace']['git']['discard']>[1],
                token?: CancellationToken,
            ) =>
                request<null | { canceled: true }>(
                    'git.discard',
                    {
                        repositoryId: repo.id,
                        repositoryName: repo.name,
                        scope,
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

import type { MethodResult } from '@shared/ipc';
import type {
    FileEntry,
    FileMutationOperation,
    GitCommitDetails,
    GitCommitPage,
    GitPullRequestChanges,
    GitSummary,
    MovedFileEntry,
    MutableFileEntry,
} from '@shared/types';
import type { ExtensionViewEventContext } from '@shared/views';

type FileSearchResult = MethodResult<'files.search'>;

import { caxri } from '../../lib/caxri';

export interface ResourceExplorerClient {
    readonly viewId: string;
    acknowledgeOperation(operationId: string, signal?: AbortSignal): Promise<null>;
    cancelOperation(operationId: string, signal?: AbortSignal): Promise<FileMutationOperation>;
    copy(path: string, directory: string, signal?: AbortSignal): Promise<MutableFileEntry>;
    create(
        options: {
            operationId: string;
            directory: string;
            name: string;
            kind: 'file' | 'directory';
        },
        signal?: AbortSignal,
    ): Promise<MutableFileEntry>;
    getOperation(operationId: string, signal?: AbortSignal): Promise<FileMutationOperation | null>;
    list(directory?: string, signal?: AbortSignal): Promise<FileEntry[]>;
    listOperations(signal?: AbortSignal): Promise<FileMutationOperation[]>;
    move(
        options: {
            operationId: string;
            path: string;
            directory: string;
            conflict?: 'reject' | 'rename' | 'replace';
        },
        signal?: AbortSignal,
    ): Promise<MovedFileEntry>;
    rename(
        options: { operationId: string; path: string; name: string },
        signal?: AbortSignal,
    ): Promise<MovedFileEntry>;
    reveal(path: string, signal?: AbortSignal): Promise<null>;
    search(
        options: {
            mode: 'name' | 'content';
            query: string;
            caseSensitive?: boolean;
            wholeWord?: boolean;
            regex?: boolean;
            include?: string;
            exclude?: string;
        },
        signal?: AbortSignal,
    ): Promise<FileSearchResult>;
    trash(
        path: string,
        options?: { hasUnsavedChanges?: boolean },
        signal?: AbortSignal,
    ): Promise<MutableFileEntry | { canceled: true }>;
}

export interface SourceControlClient {
    readonly viewId: string;
    commitDetails(
        options: { repositoryId: string; sha: string; path?: string },
        signal?: AbortSignal,
    ): Promise<GitCommitDetails>;
    commits(
        options: {
            repositoryId: string;
            offset?: number;
            pageSize?: number;
            path?: string;
        },
        signal?: AbortSignal,
    ): Promise<GitCommitPage>;
    discard(
        repo: { id: string; name: string },
        scope:
            { kind: 'all'; fileCount: number } | { kind: 'file'; path: string; untracked: boolean },
        signal?: AbortSignal,
    ): Promise<{ canceled: true } | null>;
    pullRequestChanges(
        repoId: string,
        refresh?: number,
        signal?: AbortSignal,
    ): Promise<GitPullRequestChanges | null>;
    remoteHost(repoId: string, signal?: AbortSignal): Promise<string | null>;
    summary(refresh?: number, signal?: AbortSignal): Promise<GitSummary>;
    sync(repoId: string, signal?: AbortSignal): Promise<null>;
}

type ViewOperation =
    | 'files.list'
    | 'files.search'
    | 'files.create'
    | 'files.copy'
    | 'files.rename'
    | 'files.move'
    | 'files.operation.get'
    | 'files.operation.list'
    | 'files.operation.cancel'
    | 'files.operation.acknowledge'
    | 'files.trash'
    | 'files.reveal'
    | 'git.summary'
    | 'git.sync'
    | 'git.discard'
    | 'git.pullRequestChanges'
    | 'git.commits'
    | 'git.commitDetails'
    | 'git.remoteHost';

export function controlledViewQueryKey(
    viewId: string,
    operation: ViewOperation,
    arguments_: Record<string, unknown>,
    contextKey?: string,
) {
    return [
        'viewContainers.viewOperation',
        { viewId, operation, arguments: arguments_, ...(contextKey && { contextKey }) },
    ] as const;
}

export function isControlledViewOperationQuery(
    queryKey: readonly unknown[],
    viewId: string,
    operation: ViewOperation,
    isArgumentsMatch: (arguments_: Record<string, unknown>) => boolean = () => true,
): boolean {
    const [method, rawParameters] = queryKey;
    if (
        method !== 'viewContainers.viewOperation' ||
        typeof rawParameters !== 'object' ||
        rawParameters === null
    )
        return false;
    const parameters = rawParameters as {
        arguments?: unknown;
        operation?: unknown;
        viewId?: unknown;
    };
    return (
        parameters.viewId === viewId &&
        parameters.operation === operation &&
        typeof parameters.arguments === 'object' &&
        parameters.arguments !== null &&
        isArgumentsMatch(parameters.arguments as Record<string, unknown>)
    );
}

async function viewOperation<Result>(
    viewId: string,
    context: ExtensionViewEventContext,
    operation: ViewOperation,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Result> {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const cancel = (): void => {
        // The provider owns request cancellation; a staged mutation may still complete exactly once.
        // eslint-disable-next-line no-void -- cancellation is best-effort and the original request owns errors
        void caxri.request('viewContainers.cancelRequest', { requestId });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
        const result = (await caxri.request('viewContainers.viewOperation', {
            viewId,
            requestId,
            context,
            operation,
            arguments: arguments_,
        } as never)) as Result;
        /**
         * Activation can still be in flight when cancellation reaches the Extension Host. Rejecting here is the final
         * generation-independent fence: a late read never enters React Query, while an already-staged mutation remains
         * recoverable through its durable operation id.
         */
        signal?.throwIfAborted();
        return result;
    } finally {
        signal?.removeEventListener('abort', cancel);
    }
}

export function createResourceExplorerClient(
    viewId: string,
    context: ExtensionViewEventContext,
): ResourceExplorerClient {
    return {
        viewId,
        acknowledgeOperation: (operationId, signal) =>
            viewOperation(viewId, context, 'files.operation.acknowledge', { operationId }, signal),
        cancelOperation: (operationId, signal) =>
            viewOperation(viewId, context, 'files.operation.cancel', { operationId }, signal),
        copy: (path, directory, signal) =>
            viewOperation(viewId, context, 'files.copy', { path, directory }, signal),
        create: (options, signal) =>
            viewOperation(viewId, context, 'files.create', options, signal),
        getOperation: (operationId, signal) =>
            viewOperation(viewId, context, 'files.operation.get', { operationId }, signal),
        list: (directory, signal) =>
            viewOperation(
                viewId,
                context,
                'files.list',
                { ...(directory !== undefined && { directory }) },
                signal,
            ),
        listOperations: (signal) =>
            viewOperation(viewId, context, 'files.operation.list', {}, signal),
        move: (options, signal) => viewOperation(viewId, context, 'files.move', options, signal),
        rename: (options, signal) =>
            viewOperation(viewId, context, 'files.rename', options, signal),
        reveal: (path, signal) => viewOperation(viewId, context, 'files.reveal', { path }, signal),
        search: (options, signal) =>
            viewOperation(viewId, context, 'files.search', options, signal),
        trash: (path, options, signal) =>
            viewOperation(viewId, context, 'files.trash', { path, ...options }, signal),
    };
}

export function createSourceControlClient(
    viewId: string,
    context: ExtensionViewEventContext,
): SourceControlClient {
    return {
        viewId,
        commitDetails: (options, signal) =>
            viewOperation(viewId, context, 'git.commitDetails', options, signal),
        commits: (options, signal) =>
            viewOperation(viewId, context, 'git.commits', options, signal),
        discard: (repo, scope, signal) =>
            viewOperation(
                viewId,
                context,
                'git.discard',
                { repositoryId: repo.id, repositoryName: repo.name, scope },
                signal,
            ),
        pullRequestChanges: (repoId, refresh = 0, signal) =>
            viewOperation(
                viewId,
                context,
                'git.pullRequestChanges',
                { repositoryId: repoId, refresh },
                signal,
            ),
        remoteHost: (repoId, signal) =>
            viewOperation(viewId, context, 'git.remoteHost', { repositoryId: repoId }, signal),
        summary: (refresh = 0, signal) =>
            viewOperation(viewId, context, 'git.summary', { refresh }, signal),
        sync: (repoId, signal) =>
            viewOperation(viewId, context, 'git.sync', { repositoryId: repoId }, signal),
    };
}

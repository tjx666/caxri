import type { CancellationToken, Event } from './index.js';
import type {
    FileEntry,
    FileMutationOperation,
    FileSearchResult,
    GitCommitDetails,
    GitCommitPage,
    GitPullRequestChanges,
    GitSummary,
    MovedFileEntry,
    MutableFileEntry,
} from './workspace.js';

export type ResourceExplorerChange =
    | { kind: 'content'; paths?: readonly string[]; overflow?: boolean }
    | { kind: 'operation' }
    | { kind: 'refresh' }
    | { kind: 'create'; itemKind: 'file' | 'directory' }
    | { kind: 'collapse' }
    | { kind: 'search' };

/**
 * Controlled views require a concrete protocol value; unlike tree branches, `null` never means "no children".
 */
export type ControlledViewProviderResult<T> = T | Promise<T>;

export interface ResourceExplorerProvider {
    readonly onDidChange?: Event<ResourceExplorerChange>;
    list(
        directory: string | undefined,
        token: CancellationToken,
    ): ControlledViewProviderResult<FileEntry[]>;
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
        token: CancellationToken,
    ): ControlledViewProviderResult<FileSearchResult>;
    create(
        options: {
            operationId: string;
            directory: string;
            name: string;
            kind: 'file' | 'directory';
        },
        token: CancellationToken,
    ): ControlledViewProviderResult<MutableFileEntry>;
    copy(
        path: string,
        directory: string,
        token: CancellationToken,
    ): ControlledViewProviderResult<MutableFileEntry>;
    rename(
        options: { operationId: string; path: string; name: string },
        token: CancellationToken,
    ): ControlledViewProviderResult<MovedFileEntry>;
    move(
        options: {
            operationId: string;
            path: string;
            directory: string;
            conflict?: 'reject' | 'rename' | 'replace';
        },
        token: CancellationToken,
    ): ControlledViewProviderResult<MovedFileEntry>;
    getOperation(
        operationId: string,
        token: CancellationToken,
    ): ControlledViewProviderResult<FileMutationOperation | null>;
    listOperations(token: CancellationToken): ControlledViewProviderResult<FileMutationOperation[]>;
    cancelOperation(
        operationId: string,
        token: CancellationToken,
    ): ControlledViewProviderResult<FileMutationOperation>;
    acknowledgeOperation(
        operationId: string,
        token: CancellationToken,
    ): ControlledViewProviderResult<void>;
    trash(
        path: string,
        options: { hasUnsavedChanges?: boolean } | undefined,
        token: CancellationToken,
    ): ControlledViewProviderResult<MutableFileEntry | { canceled: true }>;
    reveal(path: string, token: CancellationToken): ControlledViewProviderResult<void>;
}

export type SourceControlMode = 'working' | 'commit' | 'pull-request';

export type SourceControlChange =
    { kind: 'content' } | { kind: 'refresh' } | { kind: 'mode'; mode: SourceControlMode };

export interface SourceControlProvider {
    readonly onDidChange?: Event<SourceControlChange>;
    summary(refresh: number, token: CancellationToken): ControlledViewProviderResult<GitSummary>;
    sync(repoId: string, token: CancellationToken): ControlledViewProviderResult<void>;
    discard(
        repo: { id: string; name: string },
        scope:
            { kind: 'all'; fileCount: number } | { kind: 'file'; path: string; untracked: boolean },
        token: CancellationToken,
    ): ControlledViewProviderResult<{ canceled: true } | null>;
    pullRequestChanges(
        repoId: string,
        refresh: number,
        token: CancellationToken,
    ): ControlledViewProviderResult<GitPullRequestChanges | null>;
    commits(
        options: {
            repositoryId: string;
            offset?: number;
            pageSize?: number;
            path?: string;
        },
        token: CancellationToken,
    ): ControlledViewProviderResult<GitCommitPage>;
    commitDetails(
        options: { repositoryId: string; sha: string; path?: string },
        token: CancellationToken,
    ): ControlledViewProviderResult<GitCommitDetails>;
    remoteHost(
        repoId: string,
        token: CancellationToken,
    ): ControlledViewProviderResult<string | null>;
}

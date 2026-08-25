import type { CancellationToken } from './index.js';

export interface FileEntry {
    name: string;
    path: string;
    kind: 'file' | 'directory' | 'symlink';
    size?: number;
    gitIgnored?: true;
}

export interface MutableFileEntry {
    name: string;
    path: string;
    kind: 'file' | 'directory';
}

export interface MovedFileEntry extends MutableFileEntry {
    previousPath: string;
}

export interface FileSearchMatch {
    path: string;
    relativePath: string;
    line?: number;
    column?: number;
    matchLength?: number;
    preview?: string;
    previewMatchIndex?: number;
}

export interface FileSearchResult {
    mode: 'name' | 'content';
    matches: FileSearchMatch[];
    scannedFiles: number;
    truncated: boolean;
    canceled: boolean;
}

interface FileMutationOperationBase {
    id: string;
    sessionId: string;
    workbenchProjectId?: string;
    phase: 'pre_stage' | 'staged' | 'completed' | 'failed' | 'canceled';
    startedAt: number;
    updatedAt: number;
    error?: { code: string; message: string };
    result?: MutableFileEntry | MovedFileEntry;
    expectedResult?: MutableFileEntry | MovedFileEntry;
}

export type FileMutationOperation = FileMutationOperationBase &
    (
        | {
              kind: 'create';
              input: { directory: string; name: string; kind: 'file' | 'directory' };
          }
        | { kind: 'rename'; input: { path: string; name: string } }
        | {
              kind: 'move';
              input: {
                  path: string;
                  directory: string;
                  conflict: 'reject' | 'rename' | 'replace';
              };
          }
    );

/**
 * Workspace file notifications carry only bounded path hints from the authorized Workbench Root. Durable operation
 * records remain request-scoped so an extension cannot observe another Project's paths; `overflow` forces a
 * conservative root refresh.
 */
export type WorkspaceFileChange =
    { kind: 'content'; paths?: readonly string[]; overflow?: boolean } | { kind: 'operation' };

export interface WorkspaceFileSystem {
    list(directory?: string, token?: CancellationToken): Promise<FileEntry[]>;
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
        token?: CancellationToken,
    ): Promise<FileSearchResult>;
    create(
        options: {
            operationId: string;
            directory: string;
            name: string;
            kind: 'file' | 'directory';
        },
        token?: CancellationToken,
    ): Promise<MutableFileEntry>;
    copy(path: string, directory: string, token?: CancellationToken): Promise<MutableFileEntry>;
    rename(
        options: { operationId: string; path: string; name: string },
        token?: CancellationToken,
    ): Promise<MovedFileEntry>;
    move(
        options: {
            operationId: string;
            path: string;
            directory: string;
            conflict?: 'reject' | 'rename' | 'replace';
        },
        token?: CancellationToken,
    ): Promise<MovedFileEntry>;
    getOperation(
        operationId: string,
        token?: CancellationToken,
    ): Promise<FileMutationOperation | null>;
    listOperations(token?: CancellationToken): Promise<FileMutationOperation[]>;
    cancelOperation(operationId: string, token?: CancellationToken): Promise<FileMutationOperation>;
    acknowledgeOperation(operationId: string, token?: CancellationToken): Promise<void>;
    trash(
        path: string,
        options?: { hasUnsavedChanges?: boolean },
        token?: CancellationToken,
    ): Promise<MutableFileEntry | { canceled: true }>;
    reveal(path: string, token?: CancellationToken): Promise<void>;
}

export interface GitFileStatus {
    path: string;
    originalPath?: string;
    index: string;
    workingTree: string;
    kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
}

// eslint-disable-next-line unicorn/name-replacements -- Repository is the public domain term for each discovered Git root.
export interface GitRepositorySummary {
    id: string;
    kind: 'primary' | 'worktree' | 'nested' | 'submodule';
    name: string;
    rootPath: string;
    branch: string;
    head?: string;
    ahead: number;
    behind: number;
    additions: number;
    deletions: number;
    generation: number;
    changedFileCount: number;
    truncated: boolean;
    files: GitFileStatus[];
}

export interface GitSummary {
    isRepository: boolean;
    repositories: GitRepositorySummary[];
    error?: string;
}

export interface GitPullRequestChanges {
    repositoryId: string;
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    baseOid: string;
    headOid: string;
    additions: number;
    deletions: number;
    files: GitFileStatus[];
}

export interface GitCommit {
    sha: string;
    shortSha: string;
    subject: string;
    body: string;
    author: string;
    authorEmail: string;
    authoredAt: number;
    decorations: string[];
    parents: string[];
}

export interface GitCommitPage {
    commits: GitCommit[];
    nextOffset?: number;
}

export interface GitCommitFile {
    path: string;
    previousPath?: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unknown';
}

export interface GitCommitDetails {
    commit: GitCommit;
    additions: number;
    deletions: number;
    files: GitCommitFile[];
    filesTruncated: boolean;
}

export interface WorkspaceGit {
    summary(refresh?: number, token?: CancellationToken): Promise<GitSummary>;
    sync(repoId: string, token?: CancellationToken): Promise<void>;
    discard(
        repo: { id: string; name: string },
        scope:
            { kind: 'all'; fileCount: number } | { kind: 'file'; path: string; untracked: boolean },
        token?: CancellationToken,
    ): Promise<{ canceled: true } | null>;
    pullRequestChanges(
        repoId: string,
        refresh?: number,
        token?: CancellationToken,
    ): Promise<GitPullRequestChanges | null>;
    commits(
        options: {
            repositoryId: string;
            offset?: number;
            pageSize?: number;
            path?: string;
        },
        token?: CancellationToken,
    ): Promise<GitCommitPage>;
    commitDetails(
        options: {
            repositoryId: string;
            sha: string;
            path?: string;
        },
        token?: CancellationToken,
    ): Promise<GitCommitDetails>;
    remoteHost(repoId: string, token?: CancellationToken): Promise<string | null>;
}

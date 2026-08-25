import type { CancellationToken } from './index.js';

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
    /**
     * Requests cancellation before the native mutation boundary. The promise still waits for Host's authoritative
     * outcome so a completed mutation is never reported as retryable cancellation.
     */
    sync(repoId: string, token?: CancellationToken): Promise<void>;
    /**
     * Requests cancellation before confirmation/apply. Once apply starts, the promise resolves from Host's
     * authoritative completion rather than locally synthesizing `CANCELLED`.
     */
    discard(
        repoId: string,
        scope: { kind: 'all' } | { kind: 'file'; path: string },
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

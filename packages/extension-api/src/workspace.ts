import type { CancellationToken } from './index.js';

export interface GitFileStatus {
    path: string;
    originalPath?: string;
    index: string;
    workingTree: string;
    kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
    /**
     * Lines this change adds, when the Git service measured them; binary files count as zero.
     */
    additions?: number;
    /**
     * Lines this change deletes; present exactly when `additions` is.
     */
    deletions?: number;
}

export interface GitDetachedHead {
    /**
     * Subject line of the checked-out commit.
     */
    subject: string;
    /**
     * A tag, else a remote branch (`origin/main`), whose tip is exactly this commit.
     */
    reference?: string;
}

// eslint-disable-next-line unicorn/name-replacements -- public Extension API name mirrored from @caxri/protocol; renaming it is a cross-package API change outside this edit.
export interface GitRepositorySummary {
    id: string;
    kind: 'primary' | 'worktree' | 'nested' | 'submodule';
    name: string;
    rootPath: string;
    branch: string;
    head?: string;
    /**
     * Tracked remote branch; absent for an unpublished branch and for a detached HEAD.
     */
    upstream?: string;
    /**
     * Human-readable identity of a detached HEAD; present only when `branch` is `(detached)`.
     */
    detachedHead?: GitDetachedHead;
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
    unpushedCommitCount: number;
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
    /**
     * Lines this change adds, when the Git service measured them; binary files count as zero.
     */
    additions?: number;
    /**
     * Lines this change deletes; present exactly when `additions` is.
     */
    deletions?: number;
}

export interface GitCommitDetails {
    commit: GitCommit;
    additions: number;
    deletions: number;
    files: GitCommitFile[];
    filesTruncated: boolean;
}

export interface WorkspaceGit {
    /**
     * `refresh` is a monotonic nonce, not a counter of reads: only a value above the last one Host saw for this Session
     * forces fresh topology and status. Re-reads driven by `onDidChangeGit` or an active-context change should pass the
     * previous nonce so they join Host's current generation instead of forcing a parallel full refresh.
     */
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
    /**
     * `refresh` is not the `summary` nonce: Host has no last-seen memory for this read, so any nonzero value bypasses
     * the Pull Request cache and its single-flight key. Pass a nonzero value once per user action and `0` otherwise.
     */
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
    /**
     * Merges the repository's GitHub pull request with the first merge method the repository allows (squash, merge
     * commit, then rebase). `headSha` pins the merge to the head the user saw, so GitHub rejects it if the branch
     * moved. Requires `git.write`. Rejects with GitHub's own reason when the merge is refused.
     */
    mergePullRequest(
        repoId: string,
        pullRequest: { number: number; headSha: string },
        token?: CancellationToken,
    ): Promise<{ method: 'squash' | 'merge' | 'rebase' }>;
    remoteHost(repoId: string, token?: CancellationToken): Promise<string | null>;
}

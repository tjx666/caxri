export type ProjectStatusState =
    | 'success'
    | 'failure'
    | 'cancelled'
    /**
     * Executing right now.
     */
    | 'pending'
    /**
     * Accepted but not started: waiting for a runner.
     */
    | 'queued'
    | 'neutral'
    | 'unknown';

/**
 * Whether GitHub would merge a pull request right now. `unstable` has a non-required check failing or still running;
 * `blocked` waits on a branch-protection requirement; `behind` must be updated with its base first; `unknown` means
 * GitHub has not finished computing it.
 */
export type PullRequestMergeState =
    'clean' | 'unstable' | 'blocked' | 'behind' | 'conflicting' | 'unknown';

/**
 * Why a pull request is not plainly ready to merge, computed by Caxri from the filtered check rollup and the merge
 * state. `conflicting` cannot merge; every other reason should be confirmed before merging.
 */
export type PullRequestMergeBlocker =
    | 'conflicting'
    | 'checks-failed'
    | 'checks-running'
    | 'branch-protection'
    | 'behind'
    | 'mergeability-unknown';

export interface ProjectStatusCheck {
    name: string;
    state: ProjectStatusState;
    url?: string;
    durationMs?: number;
    /**
     * When the check settled, in epoch milliseconds.
     */
    completedAt?: number;
}

export interface ProjectStatusReviewThread {
    /**
     * Opens the thread's first comment on GitHub.
     */
    url: string;
    body: string;
    author?: string;
    /**
     * Epoch milliseconds of the opening comment.
     */
    createdAt?: number;
    path?: string;
    line?: number;
}

/**
 * The newest commit before a pull request's head whose checks reached a verdict, shown while the head's own checks are
 * unfinished or failing.
 */
export interface ProjectStatusPreviousChecks {
    /**
     * The commit message's first line.
     */
    title: string;
    /**
     * The commit's rollup after `projectStatus.ignoredChecks`.
     */
    state: 'success' | 'failure';
    /**
     * How many commits sit between it and the head; `1` is the head's parent.
     */
    commitsBefore: number;
    /**
     * The commit inside the pull request on GitHub.
     */
    url: string;
    /**
     * Files changed from this commit to the head; absent when the comparison could not be read.
     */
    changedFiles?: Array<{ path: string; additions: number; deletions: number }>;
}

/**
 * One row of the review summary Codex keeps on a pull request, which says whether a review ran and which commit it
 * covered even when it left no comment.
 */
export interface ProjectStatusCodexReview {
    /**
     * The review's name as the summary table writes it, such as `Code Review` or `Security Review`.
     */
    name: string;
    /**
     * The status cell's own word, such as `Completed`.
     */
    status: string;
    state: 'completed' | 'running' | 'failed' | 'unknown';
    /**
     * The short SHA the review covered.
     */
    commit?: string;
    /**
     * What started the review, such as `PR opened`, `New commits`, or `Manual request`.
     */
    trigger?: string;
    /**
     * Epoch milliseconds of the status timestamp.
     */
    updatedAt?: number;
    /**
     * Opens the summary comment.
     */
    url: string;
}

export interface ProjectStatusLinearIssue {
    identifier: string;
    title?: string;
    url?: string;
    state?: string;
    stateType?:
        'backlog' | 'canceled' | 'completed' | 'duplicate' | 'started' | 'triage' | 'unstarted';
    /**
     * `#RRGGBB` color the Linear workspace configured for this workflow state. `stateType` cannot stand in for it:
     * Linear files "In Progress", "In Review", and "Ready to Merge" all under `started`, and each workspace picks their
     * colors independently, so a state Linear shows green renders as whatever tone the type is quantized to.
     */
    stateColor?: string;
}

/**
 * Where an acceptance report sits in its own lifecycle. Distinct from {@link AcceptanceVerdict}: a report can be
 * `repairing` after a round already returned `failed`, and `accepted` is a person's decision rather than a run's
 * result.
 */
export type AcceptanceStatus =
    | 'pending'
    | 'planned'
    | 'verifying'
    | 'repairing'
    | 'delivered'
    | 'accepted'
    | 'closed'
    | 'rejected'
    | 'errored';

/**
 * What one verification round concluded. `uncertain` is a real third outcome, not a missing value: a round that could
 * not decide is explicitly different from one that has not finished.
 */
export type AcceptanceVerdict = 'passed' | 'failed' | 'uncertain';

/**
 * One acceptance report a branch is delivering against. Everything past `id` and `state` is absent until the report
 * resolves, so a link Caxri recognized but could not read still renders as itself.
 */
export interface ProjectStatusAcceptance {
    id: string;
    /**
     * The report reduced to the same vocabulary a check or a deployment reports, so a view can draw all three from one
     * presentation. Caxri computes it from `status` and `verdict`; a view must not re-derive it.
     */
    state: ProjectStatusState;
    url?: string;
    /**
     * The 1-based round the link pinned, when it named one. Absent means the link addressed the report as a whole, and
     * the latest round is the one that answered for it.
     */
    round?: number;
    title?: string;
    status?: AcceptanceStatus;
    verdict?: AcceptanceVerdict;
    passedChecks?: number;
    totalChecks?: number;
    roundCount?: number;
}

/**
 * The Git commit a provider built. Absent when the deployment came from a direct CLI upload rather than a connected
 * repository, so a view must keep a fallback identity for the deployment.
 */
export interface ProjectStatusDeploymentCommit {
    sha: string;
    /**
     * Subject line only. Providers carry the full message, and a body turns a one-line row into a paragraph.
     */
    message?: string;
    authorLogin?: string;
    url?: string;
}

export interface ProjectStatusDeployment {
    environment: 'production' | 'preview';
    hostname: string;
    state: ProjectStatusState;
    url: string;
    inspectorUrl?: string;
    createdAt?: number;
    commit?: ProjectStatusDeploymentCommit;
}

export interface ProjectStatusError {
    source: 'acceptance' | 'github' | 'linear' | 'vercel';
    kind: 'prerequisite' | 'failure';
    /**
     * Present when the failure describes the whole Project rather than the repository reporting it (a lost connection,
     * or a provider budget the account shares), so a view can state it once instead of per repository.
     */
    reason?: 'network' | 'rate-limited' | 'tls';
    message: string;
    hint: string;
    /**
     * Epoch ms when Caxri queries this provider again, for `rate-limited` failures whose deadline is known. Compare it
     * against the current time: a cached status snapshot outlives its own pause.
     */
    retryAt?: number;
    /**
     * Where in the log viewer this failure left its record, for an error whose real explanation is only in the logs. A
     * view offering "Open Logs" passes this along so the panel opens already filtered to the failing event instead of
     * on every process's records at every level.
     */
    logs?: {
        /**
         * The viewer's text filter, in the grammar the user types: OR on commas, `!` excludes.
         */
        filter: string;
        /**
         * The levels left on: the levels the named event is written at, and no others.
         */
        levels: Array<'debug' | 'info' | 'warn' | 'error'>;
    };
}

// eslint-disable-next-line unicorn/name-replacements -- This name is part of the public project-status API contract.
export interface ProjectStatusRepository {
    id: string;
    kind: 'primary' | 'worktree' | 'nested' | 'submodule';
    name: string;
    branch: string;
    defaultBranch?: string;
    githubUrl?: string;
    branchUrl?: string;
    /**
     * Publication on origin at checkedAt; local tracking refs are never proof of remote existence.
     */
    publication?: {
        state:
            | 'checking'
            | 'unpublished'
            | 'published'
            | 'synced'
            | 'ahead'
            | 'behind'
            | 'diverged'
            | 'unknown'
            | 'no-origin'
            | 'unsupported'
            | 'detached'
            | 'unborn';
        remoteBranch?: string;
        checkedAt?: number;
        ahead?: number;
        behind?: number;
    };
    pullRequest?: {
        number: number;
        title: string;
        url: string;
        state: ProjectStatusState;
        checks: ProjectStatusCheck[];
        hiddenCheckCount: number;
        /**
         * PR lifecycle, independent of the CI rollup; absent if the provider omits it.
         */
        lifecycle?: 'draft' | 'open' | 'merged' | 'closed';
        /**
         * The head commit GitHub reports; pass it to `workspace.git.mergePullRequest` so the merge is pinned to it.
         */
        headSha?: string;
        /**
         * The branch the pull request was opened from. It differs from `branch` when the Session's own Agent delivered
         * the pull request from another worktree.
         */
        headBranch?: string;
        /**
         * The branch the pull request would merge into; absent when the provider omitted it.
         */
        baseBranch?: string;
        /**
         * The method `workspace.git.mergePullRequest` would use right now; absent when the repository settings were not
         * read or the pull request is not open.
         */
        mergeMethod?: 'merge' | 'rebase' | 'squash';
        /**
         * Whether GitHub would merge right now; absent when the provider omitted it.
         */
        mergeState?: PullRequestMergeState;
        /**
         * Why the pull request is not plainly ready to merge; absent when nothing blocks it. Computed regardless of
         * `lifecycle`.
         */
        mergeBlocker?: PullRequestMergeBlocker;
        /**
         * Unresolved, non-outdated review threads; absent when they were not read.
         */
        unresolvedReviewThreads?: ProjectStatusReviewThread[];
        /**
         * Every review thread read, resolved and outdated ones included; present exactly when `unresolvedReviewThreads`
         * is.
         */
        reviewThreadCount?: number;
        /**
         * Codex's review summary rows; empty when the pull request has none, absent when they were not read.
         */
        codexReviews?: ProjectStatusCodexReview[];
        /**
         * Present only while the head's checks are unfinished or failing and an earlier commit's checks settled.
         */
        previousChecks?: ProjectStatusPreviousChecks;
    };
    linearIssues: ProjectStatusLinearIssue[];
    acceptances: ProjectStatusAcceptance[];
    deployments?: {
        url: string;
        branchDeployments: ProjectStatusDeployment[];
        production?: ProjectStatusDeployment;
        preview?: ProjectStatusDeployment;
    };
    errors: ProjectStatusError[];
}

export interface ProjectStatusSummary {
    repositories: ProjectStatusRepository[];
    refreshedAt: number;
    error?: string;
}

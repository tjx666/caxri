import type { z } from 'zod';

import type { ProjectStatusRepository as ProjectStatusRepo } from './project-status.js';
import type { pullRequestMergeBlockerSchema } from './project-status-state.js';

export type PullRequestMergeBlocker = z.infer<typeof pullRequestMergeBlockerSchema>;

type PullRequest = NonNullable<ProjectStatusRepo['pullRequest']>;

const unsettledCheckStates = new Set<PullRequest['state']>(['pending', 'queued', 'unknown']);
const failedCheckStates = new Set<PullRequest['state']>(['failure', 'cancelled']);

/**
 * Checks come from the rollup after the user's ignored checks were filtered out rather than from GitHub's `unstable`: a
 * check the user chose to ignore is already a decision, and asking again about it would turn every merge into a
 * confirmation.
 */
export function pullRequestMergeBlocker(
    pullRequest: Pick<PullRequest, 'mergeState' | 'state'>,
): PullRequestMergeBlocker | undefined {
    if (pullRequest.mergeState === 'conflicting') return 'conflicting';
    if (failedCheckStates.has(pullRequest.state)) return 'checks-failed';
    if (unsettledCheckStates.has(pullRequest.state)) return 'checks-running';
    switch (pullRequest.mergeState) {
        case 'blocked':
            return 'branch-protection';
        case 'behind':
            return 'behind';
        case 'unknown':
            return 'mergeability-unknown';
        default:
            return undefined;
    }
}

/**
 * Names of the listed checks that failed or were cancelled, in rollup order. Empty when the rollup failed only through
 * a check an ignore pattern hides.
 */
export function failedPullRequestCheckNames(pullRequest: Pick<PullRequest, 'checks'>): string[] {
    return pullRequest.checks
        .filter((check) => failedCheckStates.has(check.state))
        .map((check) => check.name);
}

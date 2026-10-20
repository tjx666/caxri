import { z } from 'zod';

/**
 * Shared rollup state for anything that reports a check-like outcome: Project Status checks and deployments, and a
 * Session's pull request CI summary.
 *
 * `queued` and `pending` are deliberately separate. A check waiting for a runner and a check that is actually executing
 * answer different questions (whether the work has started at all, and how long it has been going) and collapsing them
 * left a page of identical spinners that said nothing about which of twenty checks was moving. GitHub draws them apart
 * for the same reason.
 */
export const projectStatusStateSchema = z.enum([
    'success',
    'failure',
    'cancelled',
    'pending',
    'queued',
    'neutral',
    'unknown',
]);

/**
 * Whether GitHub would merge the pull request right now, reduced from its `mergeable` and `mergeStateStatus` fields.
 * `clean` merges as is; `unstable` has a non-required check that is failing or still running; `blocked` is waiting on a
 * branch-protection requirement such as a required check or review; `behind` must be updated with its base first;
 * `conflicting` cannot merge until its conflicts are resolved; `unknown` means GitHub has not finished computing it.
 */
export const pullRequestMergeStateSchema = z.enum([
    'clean',
    'unstable',
    'blocked',
    'behind',
    'conflicting',
    'unknown',
]);

/**
 * Why a pull request is not plainly ready to merge, as a closed reason Server Core computes once
 * (`pullRequestMergeBlocker`) so the Desktop Status panel and the phone give the same answer. `conflicting` blocks the
 * merge outright; every other reason only asks the user to confirm first.
 */
export const pullRequestMergeBlockerSchema = z.enum([
    'conflicting',
    'checks-failed',
    'checks-running',
    'branch-protection',
    'behind',
    'mergeability-unknown',
]);

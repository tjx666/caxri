import type { GitSummaryWireRequester } from '@caxri/protocol';

/**
 * Closed set of entry points that can ask for a Git summary, recorded on every `git.summary` log record. The two wire
 * values come from the Renderer and the Extension Host bridge; the rest name Server-internal consumers that funnel
 * through the same producer, so duplicate refresh volume can be attributed to its source without a code trace.
 */
export type GitSummaryRequester =
    | GitSummaryWireRequester
    | 'discard'
    | 'overview'
    | 'projectStatus'
    | 'pullRequests'
    | 'repository'
    | 'terminal';

/**
 * Per-summary attribution counters for the `git.summary` producer boundary event. Every Git command spawned on behalf
 * of one summary increments `commandCount`, which is what the startup benchmark asserts on instead of individual
 * `git.command` records.
 */
export interface SummaryTrace {
    requester: GitSummaryRequester;
    commandCount: number;
    worktreeListed: number;
    worktreeApproved: number;
    childRepositories: number;
    statusFresh: number;
    statusJoined: number;
    statusCoalesced: number;
}

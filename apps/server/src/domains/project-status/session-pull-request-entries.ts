import type { PullRequestUnavailable, SessionPullRequest } from '@caxri/protocol';

/**
 * Entry shapes the Session pull-request service caches, and the pure predicates over them, split out so the service
 * file stays reviewable.
 */

export interface GitHubRemote {
    branch: string;
    owner: string;
    repo: string;
    rootPath: string;
}

export interface PullRequestReference {
    number: number;
    owner: string;
    repo: string;
}

export interface PullRequestEntry {
    expiresAt: number;
    value?: SessionPullRequest;
}

export interface BranchLookupEntry {
    expiresAt: number;
    value?: SessionPullRequest;
    unavailable?: PullRequestUnavailable;
}

export interface SessionEntry {
    expiresAt: number;
    /**
     * Identity of the transcript reference this entry was resolved from, so a transcript that switches PRs invalidates
     * immediately. Absent when the entry came from branch discovery alone. It is not always the identity of `value`:
     * once the transcript's pull request is settled, a different one found on the Session's branch takes the row while
     * the key keeps tracking the transcript that must still invalidate it.
     */
    key?: string;
    value?: SessionPullRequest;
    unavailable?: PullRequestUnavailable;
}

export interface ScopedSessionEntry extends SessionEntry {
    context: string;
}

/**
 * What resolving one Session did. `rebound`: its root or Agent changed mid-lookup, so the result was discarded.
 */
export interface SessionUpdate {
    lookedUp: boolean;
    outcome: 'changed' | 'gone' | 'rebound' | 'unchanged';
}

export function pullRequestKey(reference: PullRequestReference): string {
    return `${reference.owner}/${reference.repo}#${reference.number}`;
}

export function isSettled(value: SessionPullRequest | undefined): value is SessionPullRequest {
    return value?.state === 'merged' || value?.state === 'closed';
}

/**
 * Whether `value` merged before `createdAt`. A Session cannot have delivered a pull request that landed before it
 * existed, so a merely mentioned one is background the Agent cited (a related fix, an earlier change), not this
 * Session's delivery. Attributing it would also attach that merge's production deployment and Linear issues to an
 * unrelated branch, including a days-old failed deployment with a Fix action.
 */
export function wasMergedBefore(value: SessionPullRequest | undefined, createdAt: number): boolean {
    return value?.state === 'merged' && value.mergedAt !== undefined && value.mergedAt < createdAt;
}

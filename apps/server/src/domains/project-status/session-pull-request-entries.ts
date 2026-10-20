import type { PullRequestUnavailable, SessionPullRequest } from '@caxri/protocol';

/**
 * Entry shapes the Session pull-request service caches, split out so the service file stays reviewable.
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

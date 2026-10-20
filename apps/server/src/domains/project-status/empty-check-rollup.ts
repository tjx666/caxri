import type { ProjectStatusRepository as ProjectStatusRepo } from '@caxri/protocol';
import { pullRequestMergeBlocker } from '@caxri/protocol';

type PullRequest = NonNullable<ProjectStatusRepo['pullRequest']>;

/**
 * How long an open pull request's head may report no checks at all before Project Status treats the repository as
 * having no CI. GitHub registers check suites within seconds of a push, so two minutes leaves room for a slow webhook
 * without keeping a CI-less repository on the 20s pending refresh for long.
 */
export const EMPTY_CHECK_ROLLUP_GRACE_MS = 2 * 60_000;

/**
 * Bounds the remembered heads; each entry is one open pull request head that has reported an empty rollup.
 */
const MAX_TRACKED_HEADS = 256;

/**
 * Settles an open pull request whose check rollup stays empty. One empty read cannot tell "just pushed, checks not
 * registered yet" from "this repository has no CI", so the first sighting of an empty rollup for a head commit keeps
 * the pending state and starts a grace window; once the same head is still empty after the window, the checks resolve
 * as `neutral`, so the merge area stops waiting on `checks-running` and the Session leaves the pending refresh cadence.
 * A new push is a new head and starts over. Merged and closed pull requests are already settled by the parser.
 *
 * @see https://github.com/tjx666/caxri/issues/2189
 */
export class EmptyCheckRollupTracker {
    readonly #firstEmptyAt = new Map<string, number>();

    #remember(key: string, now: number): void {
        this.#firstEmptyAt.set(key, now);
        if (this.#firstEmptyAt.size <= MAX_TRACKED_HEADS) return;
        const oldest = this.#firstEmptyAt.keys().next().value;
        if (oldest !== undefined) this.#firstEmptyAt.delete(oldest);
    }

    settle(pullRequest: PullRequest | undefined, now: number): PullRequest | undefined {
        if (!pullRequest) return pullRequest;
        const key = pullRequest.headSha && `${pullRequest.url}@${pullRequest.headSha}`;
        const isEmptyOpen =
            pullRequest.state === 'pending' &&
            pullRequest.checks.length === 0 &&
            pullRequest.hiddenCheckCount === 0 &&
            (pullRequest.lifecycle === 'open' || pullRequest.lifecycle === 'draft');
        if (!key || !isEmptyOpen) {
            if (key) this.#firstEmptyAt.delete(key);
            return pullRequest;
        }
        const firstEmptyAt = this.#firstEmptyAt.get(key);
        if (firstEmptyAt === undefined) {
            this.#remember(key, now);
            return pullRequest;
        }
        if (now - firstEmptyAt < EMPTY_CHECK_ROLLUP_GRACE_MS) return pullRequest;
        const mergeBlocker = pullRequestMergeBlocker({
            mergeState: pullRequest.mergeState,
            state: 'neutral',
        });
        const settled: PullRequest = { ...pullRequest, state: 'neutral' };
        delete settled.mergeBlocker;
        return { ...settled, ...(mergeBlocker && { mergeBlocker }) };
    }
}

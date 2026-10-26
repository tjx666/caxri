import type { MobilePullRequest } from '@caxri/protocol';

import { notifyListeners } from '../../lib/notify-listeners';

/**
 * One Session's merge attempt as the phone knows it:
 *
 * - `merging`: the request is in flight.
 * - `checking`: the request died in transport, so GitHub's answer is unknown; the pull request is re-read until it
 *   settles (see {@link settleCheckedMerge}).
 * - `merged`: GitHub accepted the merge.
 * - `failed`: the merge did not happen; `message` says why.
 */
export type PullRequestMergeState =
    | { state: 'idle' }
    | { state: 'merging'; number: number }
    | { state: 'checking'; number: number }
    | { state: 'merged'; message: string; number: number }
    | { state: 'failed'; message: string };

const IDLE_MERGE: PullRequestMergeState = { state: 'idle' };

/**
 * Session-scoped merge results kept outside component state. The Session screen unmounts when the user leaves it, and
 * Project Status can keep answering from before the merge for a while (the idle poll is 120 seconds), so a merge result
 * held in a hook would regress the chip to `Ready to merge` on re-entry. A request that outlives the screen also keeps
 * writing its outcome here instead of into an unmounted component.
 */
export const createPullRequestMergeStore = () => {
    const states = new Map<string, PullRequestMergeState>();
    const listeners = new Set<() => void>();
    const update = (
        key: string,
        change: (current: PullRequestMergeState) => PullRequestMergeState,
    ): void => {
        const current = states.get(key) ?? IDLE_MERGE;
        const next = change(current);
        if (next === current) return;
        if (next.state === 'idle') states.delete(key);
        else states.set(key, next);
        notifyListeners(listeners, undefined);
    };
    return {
        get: (key: string): PullRequestMergeState => states.get(key) ?? IDLE_MERGE,
        set: (key: string, next: PullRequestMergeState): void => update(key, () => next),
        /**
         * Applies `change` to the current state, so a late write can refuse to overwrite a newer one.
         */
        update,
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};

export const pullRequestMergeStore = createPullRequestMergeStore();

export const pullRequestMergeKey = (connectionScopeKey: string | null, sessionId: string): string =>
    `${connectionScopeKey ?? 'unpaired'}:${sessionId}`;

/**
 * Whether the chip should show an in-progress hint: the request is in flight, or its outcome is still being checked.
 */
export const isMergeInProgress = (merge: PullRequestMergeState): boolean =>
    merge.state === 'merging' || merge.state === 'checking';

/**
 * What the phone shows for the read pull request: GitHub accepted the merge, but Project Status can still answer from
 * before it, so a recorded merge of the same pull request wins and the sheet and chip never offer to merge it again.
 */
export function overlayMerge(
    read: MobilePullRequest | undefined,
    merge: PullRequestMergeState,
): MobilePullRequest | undefined {
    if (read && merge.state === 'merged' && merge.number === read.number)
        return { ...read, lifecycle: 'merged', mergeBlocker: undefined };
    return read;
}

/**
 * Resolves a `checking` merge from a fresh read of the pull request. `isFinalRead` marks the last attempt: an open pull
 * request is not an answer before that, because the Server keeps running `gh pr merge` after the phone disconnects and
 * the first read after reconnecting can land before it finishes.
 *
 * Returns the same object while the outcome is still open.
 */
export function settleCheckedMerge(
    merge: PullRequestMergeState,
    read: MobilePullRequest | undefined,
    isFinalRead: boolean,
    messages: { merged: (number: number) => string; notCompleted: string },
): PullRequestMergeState {
    if (merge.state !== 'checking') return merge;
    if (read?.number === merge.number && read.lifecycle === 'merged')
        return { state: 'merged', number: merge.number, message: messages.merged(merge.number) };
    if (!isFinalRead) return merge;
    // The pull request is gone from the Session or still open: the merge did not happen, so say so.
    return { state: 'failed', message: messages.notCompleted };
}

/**
 * A closed sheet drops a failed attempt so reopening it after fixing the blocker does not repeat the old error. Any
 * other state keeps: an in-flight merge's outcome must survive the sheet, and a merged one backs the chip.
 */
export function dismissFailedMerge(merge: PullRequestMergeState): PullRequestMergeState {
    return merge.state === 'failed' ? IDLE_MERGE : merge;
}

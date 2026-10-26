import type { MobilePullRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    createPullRequestMergeStore,
    dismissFailedMerge,
    isMergeInProgress,
    overlayMerge,
    pullRequestMergeKey,
    settleCheckedMerge,
} from '../pull-request-merge-store';

const pr = (overrides: Partial<MobilePullRequest> = {}): MobilePullRequest => ({
    repositoryId: 'primary',
    number: 42,
    title: 'Delivery',
    url: 'https://github.com/owner/example/pull/42',
    lifecycle: 'open',
    checks: 'success',
    checkCount: 1,
    failedChecks: [],
    failedCheckCount: 0,
    headSha: 'a'.repeat(40),
    ...overrides,
});

const messages = { merged: (number: number) => `Merged #${number}.`, notCompleted: 'Not done' };
const checking = { state: 'checking', number: 42 } as const;

describe('Session-scoped pull request merge store', () => {
    it('keeps a merge result across re-entry so a stale read does not regress the chip', () => {
        const store = createPullRequestMergeStore();
        const key = pullRequestMergeKey('scope', 'session-1');
        store.set(key, { state: 'merged', number: 42, message: 'Merged' });
        // Re-entering the Session reads the old open pull request from Project Status.
        const merge = store.get(pullRequestMergeKey('scope', 'session-1'));
        expect(overlayMerge(pr(), merge)).toMatchObject({ lifecycle: 'merged' });
        expect(overlayMerge(pr({ number: 43 }), merge)?.lifecycle).toBe('open');
        expect(store.get(pullRequestMergeKey('scope', 'session-2')).state).toBe('idle');
        expect(store.get(pullRequestMergeKey('other', 'session-1')).state).toBe('idle');
    });

    it('notifies subscribers and ignores no-op updates', () => {
        const store = createPullRequestMergeStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.set('k', { state: 'merging', number: 42 });
        store.update('k', (current) => current);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.set('k', { state: 'idle' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('marks merging and checking as in progress for the chip hint', () => {
        expect(isMergeInProgress({ state: 'merging', number: 1 })).toBe(true);
        expect(isMergeInProgress(checking)).toBe(true);
        expect(isMergeInProgress({ state: 'merged', number: 1, message: '' })).toBe(false);
        expect(isMergeInProgress({ state: 'idle' })).toBe(false);
    });

    it('drops only a failed attempt when the sheet closes', () => {
        expect(dismissFailedMerge({ state: 'failed', message: 'x' })).toEqual({ state: 'idle' });
        expect(dismissFailedMerge(checking)).toBe(checking);
    });
});

describe('settling a merge whose request died in transport', () => {
    it('converges to merged as soon as the re-read shows the merge', () => {
        expect(settleCheckedMerge(checking, pr({ lifecycle: 'merged' }), false, messages)).toEqual({
            state: 'merged',
            number: 42,
            message: 'Merged #42.',
        });
    });

    it('keeps checking while the pull request is open until the final read', () => {
        expect(settleCheckedMerge(checking, pr(), false, messages)).toBe(checking);
    });

    it('reports the merge as not completed when the final read still shows it open', () => {
        expect(settleCheckedMerge(checking, pr(), true, messages)).toEqual({
            state: 'failed',
            message: 'Not done',
        });
        expect(settleCheckedMerge(checking, undefined, true, messages).state).toBe('failed');
    });

    it('never touches a state that is not checking', () => {
        const merging = { state: 'merging', number: 42 } as const;
        expect(settleCheckedMerge(merging, pr({ lifecycle: 'merged' }), true, messages)).toBe(
            merging,
        );
    });
});

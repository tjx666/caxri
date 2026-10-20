import { describe, expect, it, vi } from 'vitest';

import { GitHubReferenceStore } from '../github-reference';

const lookup = { cwd: '/tmp', owner: 'o', repo: 'r', number: 7 };

function pullRequest(state: 'closed' | 'open', mergedAt: string | null = null) {
    return JSON.stringify({
        number: 7,
        state,
        title: 'Change',
        html_url: 'https://github.com/o/r/pull/7',
        pull_request: { merged_at: mergedAt },
    });
}

function createStore(outputs: string[]) {
    let clock = 0;
    const runner = vi.fn(() => Promise.resolve(outputs.shift() ?? ''));
    const store = new GitHubReferenceStore(runner, { now: () => clock });
    return {
        runner,
        store,
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

describe('GitHubReferenceStore', () => {
    it('re-reads an open pull request after a minute so a browser merge shows up', async () => {
        const { advance, runner, store } = createStore([
            pullRequest('open'),
            pullRequest('closed', '2026-01-01T00:00:00Z'),
        ]);
        expect((await store.view(lookup))?.isMerged).toBe(false);
        advance(30_000);
        await store.view(lookup);
        expect(runner).toHaveBeenCalledTimes(1);
        advance(31_000);
        expect((await store.view(lookup))?.isMerged).toBe(true);
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('keeps a merged pull request for ten minutes', async () => {
        const { advance, runner, store } = createStore([pullRequest('closed', '2026-01-01')]);
        await store.view(lookup);
        advance(9 * 60_000);
        await store.view(lookup);
        expect(runner).toHaveBeenCalledTimes(1);
        advance(61_000);
        await store.view(lookup);
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('forgets one reference so the next read refetches immediately', async () => {
        const { runner, store } = createStore([
            pullRequest('open'),
            pullRequest('closed', '2026-01-01'),
        ]);
        await store.view(lookup);
        store.forget('o', 'r', 7);
        expect((await store.view(lookup))?.isMerged).toBe(true);
        expect(runner).toHaveBeenCalledTimes(2);
    });
});

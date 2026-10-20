import { describe, expect, it, vi } from 'vitest';

import { MergeMethodStore } from '../merge-method';

const pullRequest = {
    number: 1,
    title: 'PR',
    url: 'https://github.com/a/b/pull/1',
    lifecycle: 'open' as const,
    state: 'success' as const,
    checks: [],
    hiddenCheckCount: 0,
};
const context = { owner: 'a', repo: 'b' };

function store(settings: Record<string, unknown> | Error) {
    const runner = vi.fn(() =>
        settings instanceof Error
            ? Promise.reject(settings)
            : Promise.resolve(JSON.stringify(settings)),
    );
    const telemetry = {
        observe: ({ run }: { run: () => Promise<string> }) => run(),
        recordParseFailure: vi.fn(),
    };
    return { runner, instance: new MergeMethodStore(telemetry, runner) };
}

describe('MergeMethodStore', () => {
    it('projects the method the merge will pick, squash first', async () => {
        const { instance } = store({ squashMergeAllowed: true, mergeCommitAllowed: true });
        expect((await instance.attach('/r', context, pullRequest, false))?.mergeMethod).toBe(
            'squash',
        );
    });

    it('falls to merge commit then rebase as the repository disallows methods', async () => {
        expect(
            (
                await store({ mergeCommitAllowed: true }).instance.attach(
                    '/r',
                    context,
                    pullRequest,
                    false,
                )
            )?.mergeMethod,
        ).toBe('merge');
        expect(
            (
                await store({ rebaseMergeAllowed: true }).instance.attach(
                    '/r',
                    context,
                    pullRequest,
                    false,
                )
            )?.mergeMethod,
        ).toBe('rebase');
    });

    it('reads once per repository until a forced refresh', async () => {
        const { instance, runner } = store({ squashMergeAllowed: true });
        await instance.attach('/r', context, pullRequest, false);
        await instance.attach('/r', context, pullRequest, false);
        expect(runner).toHaveBeenCalledTimes(1);
        await instance.attach('/r', context, pullRequest, true);
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('spends no query on a pull request that cannot be merged and survives a failed read', async () => {
        const { instance, runner } = store(new Error('boom'));
        const merged = { ...pullRequest, lifecycle: 'merged' as const };
        expect(await instance.attach('/r', context, merged, false)).toBe(merged);
        expect(runner).not.toHaveBeenCalled();
        expect(await instance.attach('/r', context, pullRequest, false)).toBe(pullRequest);
    });
});

import { describe, expect, it, vi } from 'vitest';

import { harness, pullRequestJson } from './session-pull-requests.fixture';

describe('SessionPullRequestService change notifications', () => {
    it('reports a pull request that merged since the last sweep, with its merge time, and stays quiet otherwise', async () => {
        let state = 'OPEN';
        const heard: Array<[string | undefined, string | undefined, number | undefined]> = [];
        const clock = { now: 0 };
        const { service } = await harness({
            now: () => clock.now,
            onPullRequestChanged: (_sessionId, previous, next) =>
                heard.push([previous?.state, next?.state, next?.mergedAt]),
            gh: (arguments_) =>
                Promise.resolve(
                    arguments_[1] === 'list'
                        ? JSON.stringify([{ number: 19_024, state }])
                        : pullRequestJson({ state, mergedAt: '2026-10-21T01:00:00Z' }),
                ),
        });

        await service.refresh();
        clock.now += 120_000;
        await service.refresh();
        state = 'MERGED';
        clock.now += 120_000;
        await service.refresh();
        clock.now += 20 * 60_000;
        await service.refresh();

        expect(heard).toEqual([
            [undefined, 'open', undefined],
            ['open', 'merged', Date.parse('2026-10-21T01:00:00Z')],
        ]);
    });
});

describe('SessionPullRequestService snapshot sweep under machine load', () => {
    const loadedGate = { shouldDefer: () => true };

    it('still sweeps a Session that has no projection yet, because there is nothing to keep showing', async () => {
        const gh = vi.fn((arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[1] === 'list'
                    ? JSON.stringify([{ number: 19_024, state: 'OPEN' }])
                    : pullRequestJson({ state: 'OPEN' }),
            ),
        );
        const { service } = await harness({ gh, load: loadedGate });

        service.snapshot();

        await vi.waitFor(() =>
            expect(service.snapshot().pullRequests['session-1']).toMatchObject({ number: 19_024 }),
        );
    });

    it('defers the sweep of an expired projection and keeps showing the last one', async () => {
        const clock = { now: 0 };
        const gh = vi.fn((arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[1] === 'list'
                    ? JSON.stringify([{ number: 19_024, state: 'OPEN' }])
                    : pullRequestJson({ state: 'OPEN' }),
            ),
        );
        const { service } = await harness({ gh, load: loadedGate, now: () => clock.now });
        await service.refresh();
        const calls = gh.mock.calls.length;
        clock.now += 120_000;

        expect(service.snapshot().pullRequests['session-1']).toMatchObject({ number: 19_024 });
        await Promise.resolve();

        expect(gh.mock.calls.length).toBe(calls);
    });
});

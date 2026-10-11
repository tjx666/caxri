import { describe, expect, it } from 'vitest';

import { createdPullRequestLines, harness, pullRequestJson } from './session-pull-requests.fixture';

function viewCalls(runner: Awaited<ReturnType<typeof harness>>['runner']) {
    return runner.mock.calls.filter(
        ([command, arguments_]) => command === 'gh' && arguments_[1] === 'view',
    );
}

describe('SessionPullRequestService.resolve', () => {
    it('answers the transcript’s pull request for one Session without waiting for a sweep', async () => {
        const { emitted, runner, service, setTranscript } = await harness({
            branch: 'feat/other',
            gh: () => Promise.resolve(pullRequestJson({ state: 'OPEN' })),
        });
        await setTranscript(createdPullRequestLines);

        const resolution = await service.resolve('session-1');

        expect(resolution?.value).toMatchObject({
            number: 19_024,
            source: 'agent',
            url: 'https://github.com/example/example/pull/19024',
        });
        expect(emitted).toEqual([
            { event: 'sessionPullRequests.changed', payload: { sessionIds: ['session-1'] } },
        ]);
        // The sidebar reads the same projection, so its snapshot needs no lookup of its own.
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(19_024);
        expect(viewCalls(runner)).toHaveLength(1);
    });

    it('reuses a projection still within its TTL', async () => {
        const { runner, service, setTranscript } = await harness({
            gh: () => Promise.resolve(pullRequestJson({ state: 'OPEN' })),
        });
        await setTranscript(createdPullRequestLines);
        await service.resolve('session-1');

        await service.resolve('session-1');

        expect(viewCalls(runner)).toHaveLength(1);
    });

    it('shares one lookup with a sweep resolving the same Session', async () => {
        const { emitted, runner, service, setTranscript } = await harness({
            gh: () => Promise.resolve(pullRequestJson({ state: 'OPEN' })),
        });
        await setTranscript(createdPullRequestLines);

        await Promise.all([service.refresh(), service.resolve('session-1')]);

        expect(viewCalls(runner)).toHaveLength(1);
        expect(emitted).toHaveLength(1);
    });

    it('re-asks a failed lookup on the next read instead of holding it for the failure TTL', async () => {
        let isSignedIn = false;
        const { runner, service, setTranscript } = await harness({
            gh: () =>
                isSignedIn
                    ? Promise.resolve(pullRequestJson({ state: 'OPEN' }))
                    : Promise.reject(new Error('not logged in')),
        });
        await setTranscript(createdPullRequestLines);
        expect((await service.resolve('session-1'))?.unavailable).toBeDefined();

        isSignedIn = true;
        const resolution = await service.resolve('session-1');

        expect(resolution?.unavailable).toBeUndefined();
        expect(resolution?.value?.number).toBe(19_024);
        expect(viewCalls(runner)).toHaveLength(2);
    });

    it('confirms a Session with no pull request as an empty resolution', async () => {
        const { service } = await harness({});

        expect(await service.resolve('session-1')).toEqual({});
    });

    it('does not answer for a Session it does not track', async () => {
        const { service } = await harness({});

        expect(await service.resolve('missing-session')).toBeUndefined();
    });
});

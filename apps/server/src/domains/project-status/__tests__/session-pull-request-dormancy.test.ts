import { describe, expect, it } from 'vitest';

import { ExternalStatusCliError } from '../../external-status/index';
import { harness, pullRequestJson, session } from './session-pull-requests.fixture';

const DAY_MS = 24 * 60 * 60_000;

function openPullRequest(arguments_: readonly string[]): Promise<string> {
    return Promise.resolve(
        arguments_[1] === 'list'
            ? JSON.stringify([{ number: 42, state: 'OPEN' }])
            : pullRequestJson({ number: 42, state: 'OPEN' }),
    );
}

/**
 * The sidebar sweep over Sessions nobody touched for a day: their badges stay, but cost one lookup an hour.
 */
describe('SessionPullRequestService dormant Sessions', () => {
    it('re-checks a Session untouched for a day hourly, and wakes it on new activity', async () => {
        let now = 2 * DAY_MS;
        const dormant = session({ sessionActivityAt: 0, lastVisitedAt: 0 });
        const { runner, service } = await harness({
            sessions: [dormant],
            now: () => now,
            gh: openPullRequest,
        });
        const ghCalls = () => runner.mock.calls.filter(([command]) => command === 'gh').length;

        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(42);
        const afterFirstSweep = ghCalls();
        expect(afterFirstSweep).toBeGreaterThan(0);

        // Past the open pull request's one-minute TTL, but inside the dormant interval.
        now += 10 * 60_000;
        await service.refresh();
        expect(ghCalls()).toBe(afterFirstSweep);

        now += 60 * 60_000;
        await service.refresh();
        const afterHourlyCheck = ghCalls();
        expect(afterHourlyCheck).toBeGreaterThan(afterFirstSweep);

        // A new Agent turn makes it active again: the normal TTL applies on the very next sweep.
        dormant.sessionActivityAt = now;
        now += 2 * 60_000;
        await service.refresh();
        expect(ghCalls()).toBeGreaterThan(afterHourlyCheck);
    });

    it('keeps retrying a dormant Session whose last lookup failed, and honors a forced refresh', async () => {
        let now = 2 * DAY_MS;
        let isUnavailable = true;
        const { runner, service } = await harness({
            sessions: [session({ sessionActivityAt: 0, lastVisitedAt: 0 })],
            now: () => now,
            gh: (arguments_) =>
                isUnavailable
                    ? Promise.reject(new ExternalStatusCliError('gh', 'other', 'network'))
                    : openPullRequest(arguments_),
        });
        const ghCalls = () => runner.mock.calls.filter(([command]) => command === 'gh').length;

        await service.refresh();
        expect(service.snapshot().unavailable?.['session-1']).toBeDefined();

        // A failed projection is never deferred for an hour: the next sweep after the failure back-off retries it.
        isUnavailable = false;
        now += 2 * 60_000;
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.number).toBe(42);

        const beforeForced = ghCalls();
        now += 2 * 60_000;
        await service.refreshSession('session-1');
        expect(ghCalls()).toBeGreaterThan(beforeForced);
    });
});

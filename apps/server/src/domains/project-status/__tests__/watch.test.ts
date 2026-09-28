import type { ServerEvent } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectStatusService } from '..';
import {
    checkPayload,
    cleanupProjectStatusFixtures,
    githubOnlyRunner,
    gitSummary,
    logger,
} from './project-status.fixture';

afterEach(cleanupProjectStatusFixtures);

describe('ProjectStatusService delivery watch over every Session', () => {
    async function watchedService(sessionIds: readonly string[], conclusion: () => string) {
        let clock = 1_000_000;
        const timers: Array<{ callback: () => void; delayMs: number }> = [];
        const emitted = vi.fn<(event: ServerEvent) => void>();
        const runner = githubOnlyRunner(() =>
            checkPayload({
                name: 'unit',
                conclusion: conclusion(),
                completedAt: new Date(clock).toISOString(),
            }),
        );
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                clearTimer: () => {},
                emit: emitted,
                listWatchedSessions: () => sessionIds,
                now: () => clock,
                setTimer: (callback, delayMs) => {
                    timers.push({ callback, delayMs });
                    return { unref: () => {} } as unknown as NodeJS.Timeout;
                },
                settings: () => defaultAppSettings,
            },
        );
        const watchRounds = () => timers.filter((timer) => timer.delayMs >= 60_000);
        /**
         * Advances past every cache TTL and fires the latest watch timer, resolving once the round re-armed.
         */
        const runRound = async (): Promise<void> => {
            clock += 5 * 60_000;
            const armed = watchRounds().length;
            watchRounds().at(-1)!.callback();
            await vi.waitFor(() => expect(watchRounds().length).toBe(armed + 1));
        };
        const alerts = () =>
            emitted.mock.calls
                .map(([event]) => event)
                .filter((event) => event.event === 'projectStatus.alert');
        const ghCalls = (): number =>
            vi.mocked(runner).mock.calls.filter(([command]) => command === 'gh').length;
        return { alerts, ghCalls, runRound, service, timers };
    }

    it('alerts on a failure in a Session the user is not looking at', async () => {
        let conclusion = 'SUCCESS';
        const { alerts, runRound, service } = await watchedService(
            ['session-background'],
            () => conclusion,
        );
        service.startDeliveryWatch();
        await runRound();
        expect(alerts()).toEqual([]);

        conclusion = 'FAILURE';
        await runRound();
        expect(alerts()).toEqual([
            {
                event: 'projectStatus.alert',
                payload: {
                    sessionId: 'session-background',
                    kind: 'check',
                    repository: 'project',
                    branch: 'feature/status',
                    name: 'unit',
                    url: 'https://github.com/example/project/pull/7',
                },
            },
        ]);
        service.dispose();
    });

    it('alerts on a failure first seen already failed when it happened after startup', async () => {
        const { alerts, runRound, service } = await watchedService(
            ['session-background'],
            () => 'FAILURE',
        );
        service.startDeliveryWatch();
        await runRound();
        expect(alerts()).toHaveLength(1);
        service.dispose();
    });

    it('refreshes one Session per repository and branch, and notifies once', async () => {
        let conclusion = 'SUCCESS';
        const { alerts, ghCalls, runRound, service } = await watchedService(
            ['session-a', 'session-b', 'session-c'],
            () => conclusion,
        );
        service.startDeliveryWatch();
        await runRound();
        const firstRound = ghCalls();
        conclusion = 'FAILURE';
        await runRound();
        expect(ghCalls() - firstRound).toBe(firstRound);
        expect(alerts()).toHaveLength(1);
        service.dispose();
    });

    it('fetches nothing while delivery notifications are disabled', async () => {
        const timers: Array<{ callback: () => void; delayMs: number }> = [];
        const runner = githubOnlyRunner(() =>
            checkPayload({ name: 'unit', conclusion: 'FAILURE' }),
        );
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                clearTimer: () => {},
                listWatchedSessions: () => ['session-background'],
                setTimer: (callback, delayMs) => {
                    timers.push({ callback, delayMs });
                    return { unref: () => {} } as unknown as NodeJS.Timeout;
                },
                settings: () => ({
                    ...defaultAppSettings,
                    'projectStatus.notifications.enabled': false,
                }),
            },
        );
        service.startDeliveryWatch();
        timers.at(-1)!.callback();
        await vi.waitFor(() => expect(timers).toHaveLength(2));
        expect(runner).not.toHaveBeenCalled();
        service.dispose();
    });
});

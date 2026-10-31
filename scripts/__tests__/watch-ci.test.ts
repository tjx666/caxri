import { describe, expect, it, vi } from 'vitest';

import type { WatchedJob, WatchState } from '../watch-ci';
import {
    buildWatchState,
    canFollowSharedState,
    formatCiNotification,
    formatRunSummary,
    isHeartbeatStale,
    isRunSettled,
    newlyFailedJobs,
    nextBackoffMs,
    withDeadline,
} from '../watch-ci';

const job = (name: string, status: string, conclusion: string): WatchedJob => ({
    conclusion,
    name,
    status,
});

const sharedState = (overrides: Partial<WatchState> = {}): WatchState => ({
    attempt: 1,
    conclusion: '',
    heartbeatAt: '2026-08-16T09:59:50Z',
    jobs: [],
    notifiedFailedJobs: [],
    pollerPid: 100,
    runId: '123',
    status: 'in_progress',
    ...overrides,
});

describe('watch-ci', () => {
    it('treats missing, malformed, and old heartbeats as stale', () => {
        const now = Date.parse('2026-08-16T10:00:00Z');
        expect(isHeartbeatStale(undefined, now)).toBe(true);
        expect(isHeartbeatStale('not-a-date', now)).toBe(true);
        expect(isHeartbeatStale('2026-08-16T09:58:00Z', now)).toBe(true);
        expect(isHeartbeatStale('2026-08-16T09:59:30Z', now)).toBe(false);
    });

    it('doubles backoff up to the five-minute cap', () => {
        expect(nextBackoffMs(20_000)).toBe(40_000);
        expect(nextBackoffMs(160_000)).toBe(300_000);
        expect(nextBackoffMs(300_000)).toBe(300_000);
        // Values below the floor re-enter the ladder at the poll interval.
        expect(nextBackoffMs(0)).toBe(40_000);
    });

    it('notifies each failed job exactly once', () => {
        const jobs = [
            job('checks', 'completed', 'failure'),
            job('e2e', 'in_progress', ''),
            job('lint', 'completed', 'success'),
            job('gate', 'completed', 'timed_out'),
        ];
        expect(newlyFailedJobs([], jobs)).toEqual(['checks', 'gate']);
        expect(newlyFailedJobs(['checks'], jobs)).toEqual(['gate']);
        expect(newlyFailedJobs(['checks', 'gate'], jobs)).toEqual([]);
    });

    it('does not notify for still-running or successful jobs', () => {
        const jobs = [job('e2e', 'in_progress', ''), job('checks', 'completed', 'success')];
        expect(newlyFailedJobs([], jobs)).toEqual([]);
    });

    it('follows a live poller only for an attempt this watcher has already polled', () => {
        const now = Date.parse('2026-08-16T10:00:00Z');
        // A rerun reuses the run ID: before its own first poll a watcher cannot tell whether a terminal state is the
        // previous attempt's, so it must not exit on it.
        const previousAttemptFailed = sharedState({ conclusion: 'failure', status: 'completed' });
        expect(canFollowSharedState(previousAttemptFailed, undefined, now, 200)).toBe(false);
        expect(canFollowSharedState(previousAttemptFailed, 2, now, 200)).toBe(false);
        expect(canFollowSharedState(sharedState({ attempt: 2 }), 2, now, 200)).toBe(true);
        expect(canFollowSharedState(sharedState({ attempt: 3 }), 2, now, 200)).toBe(true);
        expect(canFollowSharedState(sharedState(), 1, now, 100)).toBe(false);
        expect(
            canFollowSharedState(sharedState({ heartbeatAt: '2026-08-16T09:58:00Z' }), 1, now, 200),
        ).toBe(false);
        expect(canFollowSharedState(undefined, 1, now, 200)).toBe(false);
    });

    it('starts job tracking and failure notifications over for a new attempt', () => {
        const poller = { heartbeatAt: '2026-08-16T10:00:00Z', pollerPid: 200 };
        const failedAttempt = sharedState({
            conclusion: 'failure',
            jobs: [job('release', 'completed', 'failure')],
            notifiedFailedJobs: ['release'],
            status: 'completed',
        });
        const rerun = buildWatchState(
            '123',
            { attempt: 2, status: 'queued' },
            failedAttempt,
            poller,
        );
        expect(rerun).toMatchObject({
            attempt: 2,
            jobs: [],
            notifiedFailedJobs: [],
            pollerPid: 200,
        });
        const failedAgain = buildWatchState(
            '123',
            { attempt: 2, jobs: [{ conclusion: 'failure', name: 'release', status: 'completed' }] },
            rerun,
            poller,
        );
        expect(newlyFailedJobs(failedAgain.notifiedFailedJobs, failedAgain.jobs)).toEqual([
            'release',
        ]);
    });

    it('keeps the last job list and notifications while status-only polling the same attempt', () => {
        const previous = sharedState({
            jobs: [job('checks', 'completed', 'failure')],
            notifiedFailedJobs: ['checks'],
        });
        const state = buildWatchState('123', { attempt: 1, status: 'in_progress' }, previous, {
            heartbeatAt: '2026-08-16T10:00:00Z',
            pollerPid: 200,
        });
        expect(state.jobs).toEqual(previous.jobs);
        expect(state.notifiedFailedJobs).toEqual(['checks']);
    });

    it('formats a per-job summary with conclusions falling back to status', () => {
        const summary = formatRunSummary({
            attempt: 1,
            conclusion: '',
            jobs: [job('checks', 'completed', 'success'), job('e2e', 'in_progress', '')],
            runId: '123',
        });
        expect(summary).toBe('run 123: in progress\n  checks: success\n  e2e: in_progress');
        expect(
            formatRunSummary({ attempt: 2, conclusion: 'failure', jobs: [], runId: '123' }),
        ).toBe('run 123 (attempt 2): failure');
    });

    it('names the branch, PR title, workflow, and failing jobs in notifications', () => {
        const run = {
            branch: 'feat/example',
            conclusion: '',
            displayTitle: 'feat: example change',
            jobs: [job('checks', 'completed', 'failure'), job('e2e', 'in_progress', '')],
            runId: '123',
            status: 'in_progress',
            workflowName: 'CI',
        };
        expect(formatCiNotification(run, ['checks'])).toEqual({
            title: 'CI failed · feat/example',
            subtitle: 'feat: example change',
            message: 'CI failed: checks',
        });
        expect(
            formatCiNotification({
                ...run,
                conclusion: 'timed_out',
                jobs: [job('checks', 'completed', 'failure'), job('e2e', 'completed', 'timed_out')],
                status: 'completed',
            }),
        ).toEqual({
            title: 'CI failed · feat/example',
            subtitle: 'feat: example change',
            message: 'CI timed out: checks, e2e',
        });
        expect(
            formatCiNotification({
                ...run,
                conclusion: 'cancelled',
                jobs: [job('checks', 'completed', 'cancelled')],
                status: 'completed',
            }).title,
        ).toBe('CI cancelled · feat/example');
        expect(
            formatCiNotification({
                ...run,
                conclusion: 'success',
                jobs: [job('checks', 'completed', 'success')],
                status: 'completed',
            }),
        ).toEqual({
            title: 'CI passed · feat/example',
            subtitle: 'feat: example change',
            message: 'CI succeeded',
        });
    });

    it('falls back to the run id when status-only polling lost the run identity', () => {
        expect(
            formatCiNotification({
                conclusion: 'failure',
                jobs: [],
                runId: '123',
                status: 'completed',
            }),
        ).toEqual({ title: 'CI failed · run 123', message: 'CI failure' });
    });
});

describe('isRunSettled', () => {
    it('waits for a job GitHub still reports running inside a completed run', () => {
        const poll = (status: string) =>
            buildWatchState(
                '123',
                {
                    attempt: 1,
                    status: 'completed',
                    conclusion: 'success',
                    jobs: [
                        { conclusion: 'success', name: 'lint', status: 'completed' },
                        {
                            conclusion: status === 'completed' ? 'success' : '',
                            name: 'unit (1/3)',
                            status,
                        },
                    ],
                },
                undefined,
                { heartbeatAt: '2026-10-27T14:00:00Z', pollerPid: 100 },
            );

        expect(isRunSettled(poll('in_progress'))).toBe(false);
        expect(isRunSettled(poll('completed'))).toBe(true);
    });

    it('trusts the run status when only a previous job list is known', () => {
        const previous = sharedState({ jobs: [job('unit (1/3)', 'in_progress', '')] });
        const state = buildWatchState(
            '123',
            { attempt: 1, status: 'completed', conclusion: 'success' },
            previous,
            { heartbeatAt: '2026-10-27T14:00:00Z', pollerPid: 100 },
        );

        expect(state.jobs).toEqual(previous.jobs);
        expect(isRunSettled(state)).toBe(true);
        expect(isRunSettled(sharedState({ status: 'in_progress' }))).toBe(false);
    });
});

describe('withDeadline', () => {
    it('turns a poll that never settles into a retryable failure', async () => {
        vi.useFakeTimers();
        try {
            const hung = withDeadline(new Promise<never>(() => {}), 150_000, 'gh run view 1');
            const outcome = expect(hung).rejects.toThrow(
                'gh run view 1 did not settle within 150s',
            );
            await vi.advanceTimersByTimeAsync(150_000);
            await outcome;
        } finally {
            vi.useRealTimers();
        }
    });

    it('passes a settled poll through unchanged', async () => {
        await expect(withDeadline(Promise.resolve('done'), 1_000, 'poll')).resolves.toBe('done');
    });
});

describe('formatCiNotification for a skipped run', () => {
    it('reports an all-skipped downstream run as passed, not failed', () => {
        const notification = formatCiNotification({
            conclusion: 'skipped',
            jobs: [],
            runId: '5',
            status: 'completed',
            workflowName: 'Release macOS',
        });
        expect(notification.title).toBe('CI passed · run 5');
        expect(notification.message).toBe('Release macOS skipped');
    });
});

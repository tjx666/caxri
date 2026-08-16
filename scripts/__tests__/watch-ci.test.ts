import { describe, expect, it } from 'vitest';

import type { WatchedJob } from '../watch-ci';
import { formatRunSummary, isHeartbeatStale, newlyFailedJobs, nextBackoffMs } from '../watch-ci';

const job = (name: string, status: string, conclusion: string): WatchedJob => ({
    conclusion,
    name,
    status,
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

    it('formats a per-job summary with conclusions falling back to status', () => {
        const summary = formatRunSummary({
            conclusion: '',
            jobs: [job('checks', 'completed', 'success'), job('e2e', 'in_progress', '')],
            runId: '123',
        });
        expect(summary).toBe('run 123: in progress\n  checks: success\n  e2e: in_progress');
    });
});

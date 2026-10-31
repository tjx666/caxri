import { describe, expect, it, vi } from 'vitest';

import type { NativeProcessExit } from '../previous-exit';
import { previousExitReports, reportPreviousExits } from '../previous-exit';

const app = { appVersion: '0.0.150', buildNumber: 150 };
const crash: NativeProcessExit = {
    pid: 100,
    reason: 4,
    importance: 100,
    timestamp: 1_790_000_010_000,
    uncaughtClass: 'java.lang.OutOfMemoryError',
    uncaughtAt: 1_790_000_009_500,
};
const later = (exit: Partial<NativeProcessExit>, after: number): NativeProcessExit => ({
    ...crash,
    pid: crash.pid + after,
    timestamp: crash.timestamp + after * 60_000,
    ...exit,
});

describe('previous exit reports', () => {
    it('reports a crash with the class of the exception that caused it', () => {
        expect(previousExitReports([crash], app, 0)).toEqual([
            {
                reason: 'crash',
                exitedAt: crash.timestamp,
                exceptionClass: 'java.lang.OutOfMemoryError',
                ...app,
            },
        ]);
    });

    it.each([
        [5, 'crash-native'],
        [6, 'anr'],
        [3, 'low-memory'],
        [7, 'initialization-failure'],
        [9, 'excessive-resource-usage'],
    ])('maps abnormal reason %i without a crash class', (reason, expected) => {
        expect(previousExitReports([{ ...crash, reason }], app, 0)).toEqual([
            { reason: expected, exitedAt: crash.timestamp, ...app },
        ]);
    });

    it.each([
        ['unknown', 0],
        ['exit self', 1],
        ['signaled', 2],
        ['user requested', 10],
        ['user stopped', 11],
        ['package updated', 16],
    ])('leaves a normal exit (%s) unreported', (_label, reason) => {
        expect(previousExitReports([{ ...crash, reason }], app, 0)).toEqual([]);
    });

    it('leaves a low-memory kill of a cached background app unreported', () => {
        expect(previousExitReports([{ ...crash, reason: 3, importance: 400 }], app, 0)).toEqual([]);
        expect(previousExitReports([{ ...crash, reason: 3, importance: 230 }], app, 0)).toEqual([
            { reason: 'low-memory', exitedAt: crash.timestamp, ...app },
        ]);
    });

    it('reports nothing without an exit, or for an exit already reported', () => {
        expect(previousExitReports([], app, 0)).toEqual([]);
        expect(previousExitReports([crash], app, crash.timestamp)).toEqual([]);
    });

    it('reports every unreported crash oldest first, even behind a later ordinary exit', () => {
        const anr = later({ reason: 6 }, 1);
        const swipe = later({ reason: 10 }, 2);
        const reports = previousExitReports([swipe, anr, crash], app, 0);
        expect(reports.map(({ reason, exitedAt }) => [reason, exitedAt])).toEqual([
            ['crash', crash.timestamp],
            ['anr', anr.timestamp],
        ]);
        expect(previousExitReports([swipe, anr, crash], app, crash.timestamp)).toHaveLength(1);
    });

    it("keeps a process's first exit record as its cause", () => {
        // Android recorded a crashed process again 15 s later, while it sat cached in the background.
        const cachedKill = {
            ...crash,
            reason: 9,
            importance: 400,
            timestamp: crash.timestamp + 15_000,
        };
        expect(previousExitReports([cachedKill, crash], app, 0)).toEqual([
            expect.objectContaining({ reason: 'crash', exitedAt: crash.timestamp }),
        ]);
        // Once the crash is reported, the later record of the same process stays unreported.
        expect(previousExitReports([cachedKill, crash], app, crash.timestamp)).toEqual([]);
    });

    it('drops a class that belongs to an earlier crash or is not a Java class name', () => {
        const earlier = { ...crash, uncaughtAt: crash.timestamp - 120_000 };
        expect(previousExitReports([earlier], app, 0)[0]?.exceptionClass).toBeUndefined();
        const message = { ...crash, uncaughtClass: 'Failed to allocate /data/user/0/secret' };
        expect(previousExitReports([message], app, 0)).toEqual([
            { reason: 'crash', exitedAt: crash.timestamp, ...app },
        ]);
    });
});

describe('reportPreviousExits', () => {
    const anr = later({ reason: 6 }, 1);
    const ports = (reportedAt = 0) => ({
        readExits: vi.fn(() => Promise.resolve([anr, crash])),
        loadReportedAt: vi.fn(() => Promise.resolve(reportedAt)),
        saveReportedAt: vi.fn(() => Promise.resolve()),
        report: vi.fn(() => Promise.resolve(null)),
    });

    it('remembers each exit only after Desktop accepted it', async () => {
        const accepted = ports();
        await expect(reportPreviousExits(accepted, app)).resolves.toBe(2);
        expect(accepted.saveReportedAt.mock.calls).toEqual([[crash.timestamp], [anr.timestamp]]);

        const failed = ports();
        failed.report.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
        await expect(reportPreviousExits(failed, app)).rejects.toThrow('offline');
        expect(failed.saveReportedAt.mock.calls).toEqual([[crash.timestamp]]);
    });

    it('sends each exit only once', async () => {
        const repeated = ports(anr.timestamp);
        await expect(reportPreviousExits(repeated, app)).resolves.toBe(0);
        expect(repeated.report).not.toHaveBeenCalled();
    });
});

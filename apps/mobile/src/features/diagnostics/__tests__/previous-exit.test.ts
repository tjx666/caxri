import { describe, expect, it, vi } from 'vitest';

import type { NativeProcessExit } from '../previous-exit';
import { previousExitReport, reportPreviousExit } from '../previous-exit';

const app = { appVersion: '0.0.150', buildNumber: 150 };
const crash: NativeProcessExit = {
    reason: 4,
    timestamp: 1_790_000_010_000,
    uncaughtClass: 'java.lang.OutOfMemoryError',
    uncaughtAt: 1_790_000_009_500,
};

describe('previous exit report', () => {
    it('reports a crash with the class of the exception that caused it', () => {
        expect(previousExitReport([crash], app, 0)).toEqual({
            reason: 'crash',
            exitedAt: crash.timestamp,
            exceptionClass: 'java.lang.OutOfMemoryError',
            ...app,
        });
    });

    it.each([
        [5, 'crash-native'],
        [6, 'anr'],
        [3, 'low-memory'],
        [7, 'initialization-failure'],
        [9, 'excessive-resource-usage'],
    ])('maps abnormal reason %i without a crash class', (reason, expected) => {
        expect(previousExitReport([{ ...crash, reason }], app, 0)).toEqual({
            reason: expected,
            exitedAt: crash.timestamp,
            ...app,
        });
    });

    it.each([
        ['unknown', 0],
        ['exit self', 1],
        ['signaled', 2],
        ['user requested', 10],
        ['user stopped', 11],
        ['package updated', 16],
    ])('leaves a normal exit (%s) unreported', (_label, reason) => {
        expect(previousExitReport([{ ...crash, reason }], app, 0)).toBeUndefined();
    });

    it('reports nothing without an exit, or for an exit already reported', () => {
        expect(previousExitReport([], app, 0)).toBeUndefined();
        expect(previousExitReport([crash], app, crash.timestamp)).toBeUndefined();
    });

    it('finds an unreported crash behind a later ordinary exit', () => {
        const swipe = { ...crash, reason: 10, timestamp: crash.timestamp + 60_000 };
        const olderCrash = { ...crash, reason: 6, timestamp: crash.timestamp - 60_000 };
        expect(previousExitReport([swipe, crash, olderCrash], app, 0)?.exitedAt).toBe(
            crash.timestamp,
        );
        expect(
            previousExitReport([swipe, crash, olderCrash], app, crash.timestamp),
        ).toBeUndefined();
    });

    it('drops a class that belongs to an earlier crash or is not a Java class name', () => {
        const earlier = { ...crash, uncaughtAt: crash.timestamp - 120_000 };
        expect(previousExitReport([earlier], app, 0)?.exceptionClass).toBeUndefined();
        const message = { ...crash, uncaughtClass: 'Failed to allocate /data/user/0/secret' };
        expect(previousExitReport([message], app, 0)).toEqual({
            reason: 'crash',
            exitedAt: crash.timestamp,
            ...app,
        });
    });
});

describe('reportPreviousExit', () => {
    const ports = (reportedAt = 0) => ({
        readExits: vi.fn(() => Promise.resolve([crash])),
        loadReportedAt: vi.fn(() => Promise.resolve(reportedAt)),
        saveReportedAt: vi.fn(() => Promise.resolve()),
        report: vi.fn(() => Promise.resolve(null)),
    });

    it('remembers an exit only after Desktop accepted it', async () => {
        const accepted = ports();
        await expect(reportPreviousExit(accepted, app)).resolves.toBe(crash.timestamp);
        expect(accepted.saveReportedAt).toHaveBeenCalledWith(crash.timestamp);

        const failed = ports();
        failed.report.mockRejectedValue(new Error('offline'));
        await expect(reportPreviousExit(failed, app)).rejects.toThrow('offline');
        expect(failed.saveReportedAt).not.toHaveBeenCalled();
    });

    it('sends an exit only once', async () => {
        const repeated = ports(crash.timestamp);
        await expect(reportPreviousExit(repeated, app)).resolves.toBeUndefined();
        expect(repeated.report).not.toHaveBeenCalled();
    });
});

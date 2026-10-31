import { logEventCatalog } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createMobileExitReports } from '../exit-report';

const report = {
    reason: 'crash',
    exitedAt: 1_790_000_000_000,
    exceptionClass: 'java.lang.OutOfMemoryError',
    appVersion: '0.0.150',
    buildNumber: 150,
} as const;

describe('createMobileExitReports', () => {
    it("logs each device's exit once, even when a lost reply makes the phone repeat it", () => {
        const write = vi.fn();
        const reportExit = createMobileExitReports({ write });

        expect(reportExit('device-1', report)).toBeNull();
        reportExit('device-1', report);
        reportExit('device-2', report);
        reportExit('device-1', { ...report, reason: 'anr', exitedAt: report.exitedAt + 1 });
        // An older exit arriving late never replaces the newer one.
        reportExit('device-1', { ...report, exitedAt: report.exitedAt - 1 });

        expect(write.mock.calls).toEqual([
            [
                'warn',
                logEventCatalog.mobileGateway.previousExit,
                { fields: { deviceId: 'device-1', ...report } },
            ],
            [
                'warn',
                logEventCatalog.mobileGateway.previousExit,
                { fields: { deviceId: 'device-2', ...report } },
            ],
            [
                'warn',
                logEventCatalog.mobileGateway.previousExit,
                {
                    fields: {
                        deviceId: 'device-1',
                        ...report,
                        reason: 'anr',
                        exitedAt: report.exitedAt + 1,
                    },
                },
            ],
        ]);
    });

    it('omits the exception class when the phone recorded none', () => {
        const write = vi.fn();
        const withoutClass = {
            reason: report.reason,
            exitedAt: report.exitedAt,
            appVersion: report.appVersion,
            buildNumber: report.buildNumber,
        };
        createMobileExitReports({ write })('device-1', { ...withoutClass, reason: 'low-memory' });

        expect(write.mock.calls[0]?.[2]).toEqual({
            fields: { deviceId: 'device-1', ...withoutClass, reason: 'low-memory' },
        });
    });
});

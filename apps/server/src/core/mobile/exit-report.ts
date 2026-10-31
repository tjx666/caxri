import type { MobileReportExitParameters } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

/**
 * Records a paired phone's previous abnormal exit. The phone reports each exit until one report succeeds, so a retry
 * after a lost reply repeats it; the latest exit time per device keeps the log at one record per exit for this Server
 * lifetime.
 */
export const createMobileExitReports = (logger: Pick<StructuredLogger, 'write'> | undefined) => {
    const latestExitByDevice = new Map<string, number>();
    return (deviceId: string, report: MobileReportExitParameters): null => {
        if ((latestExitByDevice.get(deviceId) ?? 0) >= report.exitedAt) return null;
        latestExitByDevice.set(deviceId, report.exitedAt);
        logger?.write('warn', logEventCatalog.mobileGateway.previousExit, {
            fields: {
                deviceId,
                reason: report.reason,
                exitedAt: report.exitedAt,
                appVersion: report.appVersion,
                buildNumber: report.buildNumber,
                ...(report.exceptionClass && { exceptionClass: report.exceptionClass }),
            },
        });
        return null;
    };
};

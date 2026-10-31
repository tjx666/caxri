import type { MobileExitReason, MobileReportExitParameters } from '@caxri/protocol';
import { mobileReportExitParametersSchema } from '@caxri/protocol';

/**
 * One of the main process's past exits as Android recorded it, plus the class of the last uncaught Java exception.
 */
export interface NativeProcessExit {
    /**
     * `ApplicationExitInfo.REASON_*`.
     */
    reason: number;
    /**
     * When the process ended, in epoch milliseconds.
     */
    timestamp: number;
    uncaughtClass?: string | null;
    uncaughtAt?: number | null;
}

/**
 * Android's abnormal `ApplicationExitInfo` reasons. A user swipe, an app update, `EXIT_SELF`, and an ordinary
 * background kill are left out, so they are never reported as failures.
 * https://developer.android.com/reference/android/app/ApplicationExitInfo
 */
const ABNORMAL_EXIT_REASONS = new Map<number, MobileExitReason>([
    [3, 'low-memory'],
    [4, 'crash'],
    [5, 'crash-native'],
    [6, 'anr'],
    [7, 'initialization-failure'],
    [9, 'excessive-resource-usage'],
]);

/**
 * The uncaught-exception handler writes just before the process dies, so a recorded class older than this belongs to an
 * earlier crash.
 */
const UNCAUGHT_EXIT_WINDOW_MS = 60_000;

export interface PreviousExitApp {
    appVersion: string;
    buildNumber: number;
}

/**
 * The report for the newest abnormal exit after the last one reported, or `undefined` when there is nothing to send. A
 * crash reported while offline can be followed by an ordinary exit, so every recent exit is considered, not only the
 * newest.
 */
export const previousExitReport = (
    exits: readonly NativeProcessExit[],
    app: PreviousExitApp,
    reportedAt: number,
): MobileReportExitParameters | undefined => {
    const candidates = exits.flatMap((exit) => {
        const reason = ABNORMAL_EXIT_REASONS.get(exit.reason);
        return reason && exit.timestamp > reportedAt ? [{ exit, reason }] : [];
    });
    const newest = candidates.reduce<(typeof candidates)[number] | undefined>(
        (latest, candidate) =>
            latest && latest.exit.timestamp >= candidate.exit.timestamp ? latest : candidate,
        undefined,
    );
    if (!newest) return;
    const { exit, reason } = newest;
    const isOwnCrash =
        reason === 'crash' &&
        exit.uncaughtAt != null &&
        exit.uncaughtAt <= exit.timestamp &&
        exit.timestamp - exit.uncaughtAt <= UNCAUGHT_EXIT_WINDOW_MS;
    const parsed = mobileReportExitParametersSchema.safeParse({
        reason,
        exitedAt: exit.timestamp,
        ...(isOwnCrash && exit.uncaughtClass && { exceptionClass: exit.uncaughtClass }),
        ...app,
    });
    if (parsed.success) return parsed.data;
    // An unexpected class name must not cost the report itself.
    const withoutClass = mobileReportExitParametersSchema.safeParse({
        reason,
        exitedAt: exit.timestamp,
        ...app,
    });
    return withoutClass.success ? withoutClass.data : undefined;
};

export interface PreviousExitPorts {
    readExits(): Promise<NativeProcessExit[]>;
    loadReportedAt(): Promise<number>;
    saveReportedAt(exitedAt: number): Promise<void>;
    report(parameters: MobileReportExitParameters): Promise<unknown>;
}

/**
 * Reports the previous abnormal exit once and resolves with its exit time, or `undefined` when there is none to report.
 * The exit is remembered only after Desktop accepted it, so a failed report is sent again on the next connection;
 * Server Core drops a repeat of an exit it already logged.
 */
export const reportPreviousExit = async (
    ports: PreviousExitPorts,
    app: PreviousExitApp,
): Promise<number | undefined> => {
    const report = previousExitReport(await ports.readExits(), app, await ports.loadReportedAt());
    if (!report) return;
    await ports.report(report);
    await ports.saveReportedAt(report.exitedAt);
    return report.exitedAt;
};

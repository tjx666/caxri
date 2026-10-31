import type { MobileExitReason, MobileReportExitParameters } from '@caxri/protocol';
import { mobileReportExitParametersSchema } from '@caxri/protocol';

/**
 * The previous main process's exit as Android recorded it, plus the class of the last uncaught Java exception.
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
 * The report for an abnormal exit newer than the last one reported, or `undefined` when there is nothing to send.
 */
export const previousExitReport = (
    exit: NativeProcessExit | null,
    app: PreviousExitApp,
    reportedAt: number,
): MobileReportExitParameters | undefined => {
    const reason = exit && ABNORMAL_EXIT_REASONS.get(exit.reason);
    if (!reason || exit.timestamp <= reportedAt) return;
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
    readExit(): Promise<NativeProcessExit | null>;
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
    const report = previousExitReport(await ports.readExit(), app, await ports.loadReportedAt());
    if (!report) return;
    await ports.report(report);
    await ports.saveReportedAt(report.exitedAt);
    return report.exitedAt;
};

import type { MobileExitReason, MobileReportExitParameters } from '@caxri/protocol';
import { mobileReportExitParametersSchema } from '@caxri/protocol';

/**
 * One of the main process's past exits as Android recorded it, plus the class of the last uncaught Java exception.
 */
export interface NativeProcessExit {
    pid: number;
    /**
     * `ApplicationExitInfo.REASON_*`.
     */
    reason: number;
    /**
     * `RunningAppProcessInfo.IMPORTANCE_*` when the process died; lower is closer to the user.
     */
    importance: number;
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
 * `RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE`. The low memory killer routinely reclaims a cached background app,
 * which is not a failure; a low-memory kill counts only when the user could see or feel the app.
 */
const PERCEPTIBLE_IMPORTANCE = 230;

/**
 * The uncaught-exception handler writes just before the process dies, so a recorded class older than this belongs to an
 * earlier crash.
 */
const UNCAUGHT_EXIT_WINDOW_MS = 60_000;

export interface PreviousExitApp {
    appVersion: string;
    buildNumber: number;
}

const toReport = (
    exit: NativeProcessExit,
    reason: MobileExitReason,
    app: PreviousExitApp,
): MobileReportExitParameters | undefined => {
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

/**
 * Reports for every abnormal exit after the last one reported, oldest first.
 *
 * Android can record more than one exit for the same process: a crashed process left in the background was later
 * recorded again as an excessive-resource kill. Only each process's first record names why it ended, so later records
 * of the same `pid` are ignored. A crash that happened offline is kept even when an ordinary exit or another crash
 * followed it.
 */
export const previousExitReports = (
    exits: readonly NativeProcessExit[],
    app: PreviousExitApp,
    reportedAt: number,
): MobileReportExitParameters[] => {
    const firstExitByPid = new Map<number, NativeProcessExit>();
    for (const exit of exits) {
        const recorded = firstExitByPid.get(exit.pid);
        if (!recorded || exit.timestamp < recorded.timestamp) firstExitByPid.set(exit.pid, exit);
    }
    const unreported = Array.from(firstExitByPid.values()).filter(
        (exit) => exit.timestamp > reportedAt,
    );

    unreported.sort((left, right) => left.timestamp - right.timestamp);
    return unreported.flatMap((exit) => {
        const reason = ABNORMAL_EXIT_REASONS.get(exit.reason);
        if (!reason) return [];
        if (reason === 'low-memory' && exit.importance > PERCEPTIBLE_IMPORTANCE) return [];
        const report = toReport(exit, reason, app);
        return report ? [report] : [];
    });
};

export interface PreviousExitPorts {
    readExits(): Promise<NativeProcessExit[]>;
    loadReportedAt(): Promise<number>;
    saveReportedAt(exitedAt: number): Promise<void>;
    report(parameters: MobileReportExitParameters): Promise<unknown>;
}

/**
 * Reports each unreported abnormal exit once, oldest first, and resolves with how many were sent. Each exit is
 * remembered only after Desktop accepted it, so a failed report is sent again on the next connection; Server Core drops
 * a repeat of an exit it already logged.
 */
export const reportPreviousExits = async (
    ports: PreviousExitPorts,
    app: PreviousExitApp,
): Promise<number> => {
    const reports = previousExitReports(await ports.readExits(), app, await ports.loadReportedAt());
    for (const report of reports) {
        // eslint-disable-next-line no-await-in-loop -- Exits go oldest first, each remembered once Desktop accepted it.
        await ports.report(report);
        // eslint-disable-next-line no-await-in-loop -- The saved time must never skip an exit that was not accepted.
        await ports.saveReportedAt(report.exitedAt);
    }
    return reports.length;
};

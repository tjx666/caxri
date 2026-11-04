/**
 * CI watcher notification copy and delivery. Every outcome prints to the console for the Agent driving the watcher;
 * only a successful `Release macOS` run also rings the terminal bell and reaches the macOS notification center.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from './exec';
import type { WatchState } from './watch-ci';
import { isSuccessfulConclusion } from './watch-ci-sha';

/**
 * Job conclusions that warrant an immediate notification while the run is still in progress.
 */

export const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled']);

export interface CiNotification {
    message: string;
    subtitle?: string;
    title: string;
}

/**
 * Notification copy for a failed job or a finished run. The bare `run <id>: failure` it replaces named neither the
 * branch nor the failing job, so the operator had to open the run to learn which session broke and where.
 */

export function formatCiNotification(
    state: Pick<
        WatchState,
        'branch' | 'conclusion' | 'displayTitle' | 'jobs' | 'runId' | 'status' | 'workflowName'
    >,
    newlyFailed: string[] = [],
): CiNotification {
    const target = state.branch ?? `run ${state.runId}`;
    const subtitle = state.displayTitle;
    const workflow = state.workflowName ?? 'CI';
    const failedJobs =
        newlyFailed.length > 0
            ? newlyFailed
            : state.jobs
                  .filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion))
                  .map((job) => job.name);
    const withSubtitle = (notification: CiNotification): CiNotification =>
        subtitle ? { ...notification, subtitle } : notification;
    if (
        newlyFailed.length === 0 &&
        state.status === 'completed' &&
        isSuccessfulConclusion(state.conclusion)
    ) {
        return withSubtitle({
            title: `CI passed · ${target}`,
            message: `${workflow} ${state.conclusion === 'skipped' ? 'skipped' : 'succeeded'}`,
        });
    }
    // A cancelled run or job is usually superseded by a newer run, which `--pr` and `--sha` then follow; it is not a
    // failure. An early job notification used to say `Guards failed: guards` for a job a newer run had cancelled.
    const isCancelled =
        newlyFailed.length > 0
            ? newlyFailed.every(
                  (name) => state.jobs.find((job) => job.name === name)?.conclusion === 'cancelled',
              )
            : state.conclusion === 'cancelled';
    const outcome = isCancelled
        ? 'cancelled'
        : newlyFailed.length > 0
          ? 'failed'
          : (state.conclusion || 'failed').replaceAll('_', ' ');
    return withSubtitle({
        title: `${isCancelled ? 'CI cancelled' : 'CI failed'} · ${target}`,
        message:
            failedJobs.length > 0
                ? `${workflow} ${outcome}: ${failedJobs.join(', ')}`
                : `${workflow} ${outcome}`,
    });
}

/**
 * Workflow whose successful completion still raises a desktop notification: a published release is the one CI outcome
 * the operator acts on personally. Failures and ordinary CI results stay console-only for the Agent.
 */
const DESKTOP_NOTIFIED_WORKFLOW = 'Release macOS';

/**
 * Whether a notification also goes to the macOS notification center rather than only the console.
 */

export function shouldDeliverDesktopNotification(
    state: Pick<WatchState, 'conclusion' | 'status' | 'workflowName'>,
    newlyFailed: string[] = [],
): boolean {
    return (
        newlyFailed.length === 0 &&
        state.status === 'completed' &&
        state.conclusion === 'success' &&
        state.workflowName === DESKTOP_NOTIFIED_WORKFLOW
    );
}

/**
 * Repository icon shown on alerter notifications; resolved from the script location so worktrees work too. alerter
 * draws the image as-is, so it must be the variant with the rounded macOS plate baked in, not the full-bleed
 * `icon.png`.
 */
const APP_ICON_PATH = fileURLToPath(new URL('../build/notification-icon.png', import.meta.url));

/**
 * How long an alerter notification stays up (and the poller blocks) waiting for a click before auto-closing. Failure
 * notifications are rare, so pausing the 20s poll cadence for up to this long is an acceptable trade for
 * click-to-open.
 */
const NOTIFICATION_TIMEOUT_SECONDS = 30;

/**
 * Best-effort macOS notification. Prefers `alerter` (brew) over `osascript` because AppleScript notifications are
 * permanently branded with the Script Editor icon and cannot react to clicks; alerter shows the repository icon and
 * clicking the notification opens the run page. Falls back to `osascript` only when alerter is not installed.
 */
export async function notify(
    { message, subtitle, title }: CiNotification,
    { isDesktop, url }: { isDesktop: boolean; url?: string },
): Promise<void> {
    // The leading BEL rings the terminal bell, so it follows the same rule as the desktop notification.
    console.log(`${isDesktop ? '\u{7}' : ''}${title}: ${message}`);
    if (!isDesktop || process.platform !== 'darwin') return;
    try {
        const { stdout } = await execFileAsync('alerter', [
            '--title',
            title,
            ...(subtitle ? ['--subtitle', subtitle] : []),
            '--message',
            message,
            '--app-icon',
            APP_ICON_PATH,
            '--sound',
            'Basso',
            '--timeout',
            String(NOTIFICATION_TIMEOUT_SECONDS),
            '--json',
        ]);
        const activation = JSON.parse(stdout) as { activationType?: string };
        if (url && /clicked/iu.test(activation.activationType ?? '')) {
            await execFileAsync('open', [url]);
        }
        return;
    } catch (error) {
        // Any failure other than "alerter is not installed" still counts as attempted delivery; the console line
        // above already carries the signal.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    try {
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`;
        await execFileAsync('osascript', ['-e', script]);
    } catch {
        // Notification delivery is best-effort; the console line above already carries the signal.
    }
}

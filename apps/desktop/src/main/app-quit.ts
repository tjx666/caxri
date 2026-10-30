import type { GitReviewPendingSummary } from '@caxri/protocol';
import { errorMessage, toWireError } from '@caxri/protocol';
import type { BrowserWindow, Dialog } from 'electron';

import type { RunningWork } from './confirmations';
import { runningWorkPhrase, runningWorkTotal } from './confirmations';
import { translateMain as t } from './locale';
import type { DesktopServerConnection } from './server-connection';

export type AppQuitDecision = 'cancel' | 'keep-running' | 'stop';
export type AppQuitOutcome = 'cancelled' | 'kept-running' | 'stop-failed' | 'stopped';
/**
 * `update` is the `Restart to Update` quit: it asks only about what the restart ends, always stops Server Core (the
 * bundle it runs from is about to be replaced), and reopens Caxri on the new version.
 */
export type AppQuitIntent = 'relaunch' | 'system-shutdown' | 'update' | 'user';
/**
 * Termination signals Main treats as an already accepted quit; see {@link resolveSignalQuit}.
 */
export type AppQuitSignal = 'SIGINT' | 'SIGTERM';
type AppQuitFailureStage =
    | 'decision'
    | 'detach'
    | 'disconnect'
    | 'notification'
    | 'persist'
    | 'reviewComments'
    | 'status'
    | 'stop'
    | 'update';

export interface AppQuitImpact {
    /**
     * Running work by kind, so the prompt words it the same way the window-close and deletion confirmations do.
     */
    running: RunningWork;
    otherClientCount: number;
    /**
     * Unsent Git review comments that quitting also loses. Folded into this one prompt instead of a second dialog, so a
     * quit never stacks a review warning on top of the running-task question.
     */
    pendingReviewComments?: GitReviewPendingSummary;
}

export interface AppQuitOptions {
    acceptQuit: () => void;
    /**
     * Starts the in-place install of a staged update, if one is waiting, after Server Core stopped and right before
     * Main exits. Runs for every quit that stopped Server Core: `Restart to Update` reopens the app (`relaunch`), an
     * ordinary quit installs silently so the next launch is the new version. A quit that keeps tasks running never
     * installs, because Server Core is still running from the bundle that would be replaced.
     */
    applyUpdate: (options: { relaunch: boolean }) => Promise<unknown>;
    closeDesktop: () => Promise<void>;
    confirm: (impact: AppQuitImpact) => Promise<AppQuitDecision>;
    /**
     * The `Restart to Update` confirmation, asked only when the restart would end running work, disconnect another
     * client, or lose unsent review comments.
     */
    confirmUpdateRestart: (impact: AppQuitImpact) => Promise<'cancel' | 'restart'>;
    /**
     * Only asked when {@link AppQuitOptions.readPendingReviewComments} reports at least one pending comment and nothing
     * is running (or running work cannot be read); otherwise the comments are summarized inside
     * {@link AppQuitOptions.confirm}. See `docs/git-diff-review.md` for why quitting loses them.
     */
    confirmPendingReviewComments: (
        summary: GitReviewPendingSummary,
    ) => Promise<'cancel' | 'discard'>;
    /**
     * Asked first, before any other prompt: unsaved Editor buffers are the only quit loss the user can still prevent by
     * saving (issue caxri#1631). See `decideUnsavedEditors` for its fail-open read and fail-closed save.
     */
    decideUnsavedEditors: () => Promise<'cancel' | 'continue'>;
    detachAll: () => Promise<unknown>;
    exit: () => void;
    logFailure: (level: 'error' | 'warn', stage: AppQuitFailureStage, message: string) => void;
    notifyStopFailure: () => Promise<void>;
    persistWindowState: () => Promise<void>;
    quitIntent: () => AppQuitIntent;
    /**
     * Read fail-open: an unreachable Server during quit must not block quitting on a reminder about data that Server
     * loss may have already lost anyway.
     */
    readPendingReviewComments: () => Promise<GitReviewPendingSummary>;
    readStatus: () => Promise<AppQuitStatus>;
    /**
     * Stops Server Core and owns disposal of the Desktop attachment so a closing transport cannot start recovery.
     */
    stopServer: () => Promise<void>;
}

export interface AppQuitStatus {
    clientCount: number;
    running: RunningWork;
}

/**
 * Reads who else is connected and what is still running, in one round of parallel requests.
 */
export async function readAppQuitStatus(
    server: Pick<DesktopServerConnection, 'request'>,
): Promise<AppQuitStatus> {
    const [status, running] = await Promise.all([
        server.request('host.status'),
        server.request('terminal.runningCount'),
    ]);
    return { clientCount: status.clientCount, running };
}

export interface AppQuitPrompt {
    buttons: [string, string, string];
    cancelId: number;
    defaultId: number;
    detail: string;
    message: string;
    title: string;
    type: 'warning';
}

export function appQuitPrompt(impact: AppQuitImpact): AppQuitPrompt {
    const { otherClientCount, pendingReviewComments, running } = impact;
    const reviewCount = pendingReviewComments?.count ?? 0;
    const reviewDetail =
        reviewCount === 0
            ? ''
            : `\n\n${t(
                  reviewCount === 1 ? 'desktop.quit.reviewLossOne' : 'desktop.quit.reviewLossOther',
                  { count: reviewCount },
              )}`;
    const otherClientDetail =
        otherClientCount === 0
            ? ''
            : `\n\n${t(
                  otherClientCount === 1
                      ? 'desktop.quit.otherClientsOne'
                      : 'desktop.quit.otherClientsOther',
                  { count: otherClientCount },
              )}`;
    return {
        type: 'warning',
        title: t('desktop.quit.title'),
        /**
         * The question lives in `message` because macOS sheets and alerts do not show `title`; the title is only for
         * platforms that draw one.
         */
        message: t(
            runningWorkTotal(running) === 1
                ? 'desktop.quit.messageOne'
                : 'desktop.quit.messageOther',
            { running: runningWorkPhrase(running) },
        ),
        detail: `${t('desktop.quit.detail')}${otherClientDetail}${reviewDetail}`,
        buttons: [
            t('desktop.quit.stopTasks'),
            t('desktop.quit.keepTasks'),
            t('desktop.dialog.cancel'),
        ],
        /**
         * Keep-running remains the default because a mistaken Enter can recoverably leave work alive, while a mistaken
         * stop can destroy an in-flight shell command or Agent turn.
         */
        defaultId: 1,
        cancelId: 2,
    };
}

/**
 * Shown before `Restart to Update` ends something. Unlike {@link appQuitPrompt} there is no "keep tasks running" choice:
 * the restart replaces the bundle Server Core runs from, so the only answers are to restart now or not at all.
 */
export function updateRestartPrompt(
    impact: AppQuitImpact,
): Omit<AppQuitPrompt, 'buttons'> & { buttons: [string, string] } {
    const { otherClientCount, pendingReviewComments, running } = impact;
    const runningTotal = runningWorkTotal(running);
    const reviewCount = pendingReviewComments?.count ?? 0;
    const extras = [
        otherClientCount === 0
            ? ''
            : t(
                  otherClientCount === 1
                      ? 'desktop.quit.otherClientsOne'
                      : 'desktop.quit.otherClientsOther',
                  { count: otherClientCount },
              ),
        reviewCount === 0
            ? ''
            : t(reviewCount === 1 ? 'desktop.quit.reviewLossOne' : 'desktop.quit.reviewLossOther', {
                  count: reviewCount,
              }),
    ].filter(Boolean);
    return {
        type: 'warning',
        title: t('desktop.updateRestart.title'),
        message:
            runningTotal === 0
                ? t('desktop.updateRestart.messageIdle')
                : t(
                      runningTotal === 1
                          ? 'desktop.updateRestart.messageOne'
                          : 'desktop.updateRestart.messageOther',
                      { running: runningWorkPhrase(running) },
                  ),
        detail: [t('desktop.updateRestart.detail'), ...extras].join('\n\n'),
        buttons: [t('desktop.updateRestart.restart'), t('desktop.dialog.cancel')],
        /**
         * Cancel is both default and Escape target for the same reason as in `appQuitPrompt`: a mistaken Enter must not
         * end running work. Electron's macOS message box rebinds a shared default/cancel button to Escape only, so
         * Return deliberately does nothing here, unlike the confirmations in `confirmations.ts`.
         */
        defaultId: 1,
        cancelId: 1,
    };
}

async function confirmUpdateRestart(
    dialog: Dialog,
    window: BrowserWindow | undefined,
    impact: AppQuitImpact,
): Promise<'cancel' | 'restart'> {
    const prompt = updateRestartPrompt(impact);
    const result =
        window && !window.isDestroyed()
            ? await dialog.showMessageBox(window, prompt)
            : await dialog.showMessageBox(prompt);
    return result.response === 0 ? 'restart' : 'cancel';
}

export async function confirmAppQuit(
    dialog: Dialog,
    window: BrowserWindow | undefined,
    impact: AppQuitImpact,
): Promise<AppQuitDecision> {
    const prompt = appQuitPrompt(impact);
    const result =
        window && !window.isDestroyed()
            ? await dialog.showMessageBox(window, prompt)
            : await dialog.showMessageBox(prompt);
    return result.response === 2 ? 'cancel' : result.response === 1 ? 'keep-running' : 'stop';
}

export interface PendingReviewCommentsPrompt {
    buttons: [string, string];
    cancelId: number;
    defaultId: number;
    detail: string;
    message: string;
    title: string;
    type: 'warning';
}

/**
 * The review-only warning (issue caxri#1294): asks whether to lose local-only Git review comment drafts when no
 * Terminal or Chat is running, so there is no task question to fold them into. With running work, the same loss is one
 * paragraph of {@link appQuitPrompt} instead, so quitting shows at most one confirmation after the unsaved-Editor one.
 */
export function pendingReviewCommentsPrompt(
    summary: GitReviewPendingSummary,
): PendingReviewCommentsPrompt {
    const repoCount = summary.groups.length;
    return {
        type: 'warning',
        title: t('desktop.quit.reviewTitle'),
        // The question is the message, as in `appQuitPrompt`: macOS does not show the title.
        message: t(
            summary.count === 1
                ? 'desktop.quit.reviewMessageOne'
                : 'desktop.quit.reviewMessageOther',
            { count: summary.count },
        ),
        detail: t(
            repoCount === 1 ? 'desktop.quit.reviewDetailOne' : 'desktop.quit.reviewDetailOther',
            { count: repoCount },
        ),
        buttons: [t('desktop.quit.anyway'), t('desktop.dialog.cancel')],
        /**
         * Cancel stays the default, matching `appQuitPrompt`'s own reasoning: a mistaken Enter should recoverably keep
         * the comments around rather than discard them. As in `updateRestartPrompt`, Return deliberately does nothing.
         */
        defaultId: 1,
        cancelId: 1,
    };
}

export async function confirmPendingReviewCommentsQuit(
    dialog: Dialog,
    window: BrowserWindow | undefined,
    summary: GitReviewPendingSummary,
): Promise<'cancel' | 'discard'> {
    const prompt = pendingReviewCommentsPrompt(summary);
    const result =
        window && !window.isDestroyed()
            ? await dialog.showMessageBox(window, prompt)
            : await dialog.showMessageBox(prompt);
    return result.response === prompt.cancelId ? 'cancel' : 'discard';
}

/**
 * One composition entry point for every native quit prompt parented to the Workbench window. Takes a window getter, not
 * a window, because the caller composes the quit handler before its `mainWindow` binding is assigned, and the window
 * can later close and be recreated: a captured value stays `undefined`, so the prompt never attaches as a sheet to the
 * Workbench window. Owning all three prompts here keeps a new one from capturing the value again.
 */
export function createAppQuitPromptOptions(
    dialog: Dialog,
    getWindow: () => BrowserWindow | undefined,
): Pick<
    AppQuitOptions,
    'confirm' | 'confirmPendingReviewComments' | 'confirmUpdateRestart' | 'notifyStopFailure'
> {
    return {
        confirm: (impact) => confirmAppQuit(dialog, getWindow(), impact),
        confirmUpdateRestart: (impact) => confirmUpdateRestart(dialog, getWindow(), impact),
        confirmPendingReviewComments: (summary) =>
            confirmPendingReviewCommentsQuit(dialog, getWindow(), summary),
        notifyStopFailure: () => notifyAppQuitStopFailure(dialog, getWindow()),
    };
}

export async function notifyAppQuitStopFailure(
    dialog: Dialog,
    window: BrowserWindow | undefined,
): Promise<void> {
    const options = {
        type: 'error' as const,
        title: t('desktop.quit.stopFailureTitle'),
        message: t('desktop.quit.stopFailureMessage'),
        detail: t('desktop.quit.stopFailureDetail'),
        buttons: [t('desktop.quit.anyway')],
        defaultId: 0,
        cancelId: 0,
    };
    if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
}

function reportFailure(
    options: AppQuitOptions,
    stage: AppQuitFailureStage,
    error: unknown,
): string {
    const message = errorMessage(error, 'Unknown quit failure');
    const code = toWireError(error).code;
    /**
     * Expected Host loss is fail-open during quit; persistence and other internal failures remain actionable.
     */
    const level =
        (code === 'CANCELLED' || code === 'UNAVAILABLE') &&
        ['detach', 'disconnect', 'persist', 'reviewComments', 'status'].includes(stage)
            ? 'warn'
            : 'error';
    options.logFailure(level, stage, message);
    return message;
}

async function attempt(
    options: AppQuitOptions,
    stage: AppQuitFailureStage,
    operation: () => Promise<unknown>,
): Promise<string | undefined> {
    try {
        await operation();
        return undefined;
    } catch (error) {
        return reportFailure(options, stage, error);
    }
}

/**
 * Fail-open: an unreachable Server, or a summary with nothing pending, must never block the quit decision.
 */
async function readPendingReviewSummary(
    options: AppQuitOptions,
): Promise<GitReviewPendingSummary | undefined> {
    try {
        const summary = await options.readPendingReviewComments();
        return summary.count === 0 ? undefined : summary;
    } catch (error) {
        reportFailure(options, 'reviewComments', error);
        return undefined;
    }
}

async function readQuitStatus(options: AppQuitOptions): Promise<AppQuitStatus | undefined> {
    try {
        return await options.readStatus();
    } catch (error) {
        reportFailure(options, 'status', error);
        return undefined;
    }
}

/**
 * Fail-open on every path except an explicit Cancel: a failing dialog must not trap the user in Caxri.
 */
async function confirmReviewOnly(
    options: AppQuitOptions,
    summary: GitReviewPendingSummary | undefined,
): Promise<'cancel' | 'continue'> {
    if (!summary) return 'continue';
    try {
        return (await options.confirmPendingReviewComments(summary)) === 'cancel'
            ? 'cancel'
            : 'continue';
    } catch (error) {
        reportFailure(options, 'reviewComments', error);
        return 'continue';
    }
}

/**
 * The `Restart to Update` decision: after the unsaved-Editor question, one {@link updateRestartPrompt} when the restart
 * would end anything, otherwise none. It never keeps Server Core running. A failing dialog cancels rather than
 * restarts: unlike a quit, nothing traps the user, who can simply ask again.
 */
async function decideUpdateRestart(options: AppQuitOptions): Promise<AppQuitDecision> {
    if ((await options.decideUnsavedEditors()) === 'cancel') return 'cancel';
    const [pendingReviewComments, status] = await Promise.all([
        readPendingReviewSummary(options),
        readQuitStatus(options),
    ]);
    const impact: AppQuitImpact = {
        running: status?.running ?? { terminals: 0, chats: 0 },
        otherClientCount: Math.max(0, (status?.clientCount ?? 1) - 1),
        ...(pendingReviewComments && { pendingReviewComments }),
    };
    if (
        !pendingReviewComments &&
        impact.otherClientCount === 0 &&
        runningWorkTotal(impact.running) === 0
    )
        return 'stop';
    try {
        return (await options.confirmUpdateRestart(impact)) === 'restart' ? 'stop' : 'cancel';
    } catch (error) {
        reportFailure(options, 'decision', error);
        return 'cancel';
    }
}

/**
 * Shows at most one confirmation after the unsaved-Editor decision: running work and unsent review comments share
 * {@link appQuitPrompt}, and the review-only prompt appears only when nothing is running to ask about.
 */
async function decideAppQuit(options: AppQuitOptions): Promise<AppQuitDecision> {
    if (options.quitIntent() === 'update') return decideUpdateRestart(options);
    if (options.quitIntent() !== 'user') return 'keep-running';

    if ((await options.decideUnsavedEditors()) === 'cancel') return 'cancel';

    const [pendingReviewComments, status] = await Promise.all([
        readPendingReviewSummary(options),
        readQuitStatus(options),
    ]);

    if (!status) {
        return (await confirmReviewOnly(options, pendingReviewComments)) === 'cancel'
            ? 'cancel'
            : 'keep-running';
    }

    const impact: AppQuitImpact = {
        running: status.running,
        otherClientCount: Math.max(0, status.clientCount - 1),
        ...(pendingReviewComments && { pendingReviewComments }),
    };
    if (runningWorkTotal(impact.running) === 0) {
        if ((await confirmReviewOnly(options, pendingReviewComments)) === 'cancel') return 'cancel';
        return impact.otherClientCount === 0 ? 'stop' : 'keep-running';
    }

    try {
        return await options.confirm(impact);
    } catch (error) {
        reportFailure(options, 'decision', error);
        return 'keep-running';
    }
}

/**
 * Resolves one explicit Desktop quit without making a detached Server an invisible default. Every operation after the
 * user accepts is best-effort because an unavailable Server must never trap the user inside a quitting application.
 */
export async function resolveAppQuit(options: AppQuitOptions): Promise<AppQuitOutcome> {
    const decision = await decideAppQuit(options);
    if (decision === 'cancel') return 'cancelled';

    options.acceptQuit();
    await attempt(options, 'persist', options.persistWindowState);

    if (decision === 'stop') {
        const stopFailure = await attempt(options, 'stop', options.stopServer);
        if (stopFailure) await attempt(options, 'notification', options.notifyStopFailure);
        await attempt(options, 'disconnect', options.closeDesktop);
        // After a failed stop the installer still runs: the next launch replaces a Server Core left on the old build.
        await attempt(options, 'update', () =>
            options.applyUpdate({ relaunch: options.quitIntent() === 'update' }),
        );
        options.exit();
        return stopFailure ? 'stop-failed' : 'stopped';
    }
    return detachAndExit(options);
}

async function detachAndExit(options: AppQuitOptions): Promise<'kept-running'> {
    await attempt(options, 'detach', options.detachAll);
    await attempt(options, 'disconnect', options.closeDesktop);
    options.exit();
    return 'kept-running';
}

/**
 * Quits for a termination signal without asking. The sender (a system logout, an updater, a process manager, or `kill`
 * on the process tree) has already decided, and usually signals Server Core and Chromium's own children at the same
 * moment, so a pending quit prompt must not keep Main alive as if nothing happened: production logs showed a SIGTERM
 * that arrived while the prompt was open read every child exit as a crash, restarted Server Core, resumed an Agent, and
 * reloaded the Renderer until the follow-up SIGKILL. Takes the keep-running path because a signal is not consent to end
 * the user's Terminal and Agent processes; the same teardown signal stops them when it reached them too.
 */
async function resolveSignalQuit(options: AppQuitOptions): Promise<'kept-running'> {
    options.acceptQuit();
    await attempt(options, 'persist', options.persistWindowState);
    return detachAndExit(options);
}

/**
 * Coalesces quit requests. A `signal` bypasses a pending prompt instead of joining it (see {@link resolveSignalQuit}),
 * and acceptance runs once even when a prompt the user is answering and a signal both reach it.
 */
export function createAppQuitHandler(
    handlerOptions: AppQuitOptions,
): (signal?: AppQuitSignal) => Promise<AppQuitOutcome> {
    let pending: Promise<AppQuitOutcome> | undefined;
    let signalled: Promise<AppQuitOutcome> | undefined;
    let isAccepted = false;
    const options: AppQuitOptions = {
        ...handlerOptions,
        acceptQuit: () => {
            if (isAccepted) return;
            isAccepted = true;
            handlerOptions.acceptQuit();
        },
    };
    return (signal) => {
        if (signal) {
            /**
             * A quit the user already accepted (for example Stop Tasks, still terminating PTYs before `host.stop`)
             * finishes on its own path. Starting the signal path beside it would exit before Server Core is stopped.
             */
            if (isAccepted && pending) return pending;
            signalled ??= resolveSignalQuit(options);
            return signalled;
        }
        const run = async (): Promise<AppQuitOutcome> => {
            try {
                return await resolveAppQuit(options);
            } finally {
                pending = undefined;
            }
        };
        pending ??= run();
        return pending;
    };
}

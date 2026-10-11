import type { GitReviewPendingSummary } from '@caxri/protocol';
import { errorMessage, toWireError } from '@caxri/protocol';
import type { BrowserWindow, Dialog } from 'electron';

export type AppQuitDecision = 'cancel' | 'keep-running' | 'stop';
export type AppQuitOutcome = 'cancelled' | 'kept-running' | 'stop-failed' | 'stopped';
export type AppQuitIntent = 'relaunch' | 'system-shutdown' | 'user';
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
    | 'stop';

export interface AppQuitImpact {
    activePtyCount: number;
    otherClientCount: number;
}

export interface AppQuitOptions {
    acceptQuit: () => void;
    closeDesktop: () => Promise<void>;
    confirm: (impact: AppQuitImpact) => Promise<AppQuitDecision>;
    /**
     * Only asked when {@link AppQuitOptions.readPendingReviewComments} reports at least one pending comment: see
     * `docs/git-diff-review.md` for why quitting loses them.
     */
    confirmPendingReviewComments: (
        summary: GitReviewPendingSummary,
    ) => Promise<'cancel' | 'discard'>;
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
    readStatus: () => Promise<{ activePtyCount: number; clientCount: number }>;
    /**
     * Stops Server Core and owns disposal of the Desktop attachment so a closing transport cannot start recovery.
     */
    stopServer: () => Promise<void>;
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

function plural(count: number, singular: string, multiple = `${singular}s`): string {
    return count === 1 ? singular : multiple;
}

export function appQuitPrompt(impact: AppQuitImpact): AppQuitPrompt {
    const otherClientDetail =
        impact.otherClientCount === 0
            ? ''
            : `\n\n${impact.otherClientCount} other ${plural(impact.otherClientCount, 'client')} ${
                  impact.otherClientCount === 1 ? 'is' : 'are'
              } connected to Caxri Server. Stopping will disconnect ${
                  impact.otherClientCount === 1 ? 'it' : 'them'
              }.`;
    return {
        type: 'warning',
        title: 'Quit Caxri?',
        message: `${impact.activePtyCount} ${plural(impact.activePtyCount, 'task')} ${
            impact.activePtyCount === 1 ? 'is' : 'are'
        } still running.`,
        detail: `Quit and Stop Tasks ends every running Terminal and Agent process, releases Agent sessions so they can be resumed in other tools, and stops Caxri Server. Quit and Keep Tasks Running leaves them attached to Caxri in the background.${
            otherClientDetail
        }`,
        buttons: ['Quit and Stop Tasks', 'Quit and Keep Tasks Running', 'Cancel'],
        /**
         * Keep-running remains the default because a mistaken Enter can recoverably leave work alive, while a mistaken
         * stop can destroy an in-flight shell command or Agent turn.
         */
        defaultId: 1,
        cancelId: 2,
    };
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
 * A separate, smaller warning from {@link appQuitPrompt}: it asks whether to lose local-only Git review comment drafts
 * (issue caxri#1294), not whether to stop running Terminal/Agent processes, so it gets its own two-button prompt
 * instead of overloading the three-button task prompt with an unrelated decision.
 */
export function pendingReviewCommentsPrompt(
    summary: GitReviewPendingSummary,
): PendingReviewCommentsPrompt {
    const repoCount = summary.groups.length;
    return {
        type: 'warning',
        title: 'Quit with pending review comments?',
        message: `${summary.count} pending review ${plural(summary.count, 'comment')} will be lost.`,
        detail: `Review comments live in memory only and do not survive quitting Caxri. ${repoCount} ${plural(
            repoCount,
            'repository',
            'repositories',
        )} ${repoCount === 1 ? 'has' : 'have'} unsent comments.`,
        buttons: ['Quit Anyway', 'Cancel'],
        /**
         * Cancel stays the default, matching `appQuitPrompt`'s own reasoning: a mistaken Enter should recoverably keep
         * the comments around rather than discard them.
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
): Pick<AppQuitOptions, 'confirm' | 'confirmPendingReviewComments' | 'notifyStopFailure'> {
    return {
        confirm: (impact) => confirmAppQuit(dialog, getWindow(), impact),
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
        title: "Caxri Couldn't Stop All Tasks",
        message: 'Some background tasks may still be running.',
        detail: 'Caxri will quit now. Reopen Caxri to stop any remaining tasks before resuming their Agent sessions in another tool.',
        buttons: ['Quit Anyway'],
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
 * Fail-open on every path except an explicit Cancel: an unreachable Server, or a summary with nothing pending, must
 * never block the rest of {@link decideAppQuit} from running its own (independent) decision.
 */
async function decidePendingReviewComments(
    options: AppQuitOptions,
): Promise<'cancel' | 'continue'> {
    let summary: GitReviewPendingSummary;
    try {
        summary = await options.readPendingReviewComments();
    } catch (error) {
        reportFailure(options, 'reviewComments', error);
        return 'continue';
    }
    if (summary.count === 0) return 'continue';

    try {
        return (await options.confirmPendingReviewComments(summary)) === 'cancel'
            ? 'cancel'
            : 'continue';
    } catch (error) {
        reportFailure(options, 'reviewComments', error);
        return 'continue';
    }
}

async function decideAppQuit(options: AppQuitOptions): Promise<AppQuitDecision> {
    if (options.quitIntent() !== 'user') return 'keep-running';

    if ((await decidePendingReviewComments(options)) === 'cancel') return 'cancel';

    let status: { activePtyCount: number; clientCount: number };
    try {
        status = await options.readStatus();
    } catch (error) {
        reportFailure(options, 'status', error);
        return 'keep-running';
    }

    const impact = {
        activePtyCount: status.activePtyCount,
        otherClientCount: Math.max(0, status.clientCount - 1),
    };
    if (impact.activePtyCount === 0) return impact.otherClientCount === 0 ? 'stop' : 'keep-running';

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

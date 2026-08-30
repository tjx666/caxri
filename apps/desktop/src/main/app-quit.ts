import { errorMessage } from '@caxri/protocol';
import type { BrowserWindow, Dialog } from 'electron';

export type AppQuitDecision = 'cancel' | 'keep-running' | 'stop';
export type AppQuitOutcome = 'cancelled' | 'kept-running' | 'stop-failed' | 'stopped';
export type AppQuitIntent = 'relaunch' | 'system-shutdown' | 'user';
type AppQuitFailureStage =
    'decision' | 'detach' | 'disconnect' | 'gpu' | 'notification' | 'persist' | 'status' | 'stop';

export interface AppQuitImpact {
    activePtyCount: number;
    otherClientCount: number;
}

export interface AppQuitOptions {
    acceptQuit: () => void;
    closeDesktop: () => Promise<void>;
    confirm: (impact: AppQuitImpact) => Promise<AppQuitDecision>;
    detachAll: () => Promise<unknown>;
    drainGpuRecovery: () => Promise<void>;
    exit: () => void;
    logFailure: (stage: AppQuitFailureStage, message: string) => void;
    notifyStopFailure: () => Promise<void>;
    persistWindowState: () => Promise<void>;
    quitIntent: () => AppQuitIntent;
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
    options.logFailure(stage, message);
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

async function decideAppQuit(options: AppQuitOptions): Promise<AppQuitDecision> {
    if (options.quitIntent() !== 'user') return 'keep-running';

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
    await attempt(options, 'gpu', options.drainGpuRecovery);

    if (decision === 'stop') {
        const stopFailure = await attempt(options, 'stop', options.stopServer);
        if (stopFailure) await attempt(options, 'notification', options.notifyStopFailure);
        await attempt(options, 'disconnect', options.closeDesktop);
        options.exit();
        return stopFailure ? 'stop-failed' : 'stopped';
    }
    await attempt(options, 'detach', options.detachAll);
    await attempt(options, 'disconnect', options.closeDesktop);
    options.exit();
    return 'kept-running';
}

export function createAppQuitHandler(options: AppQuitOptions): () => Promise<AppQuitOutcome> {
    let pending: Promise<AppQuitOutcome> | undefined;
    return () => {
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

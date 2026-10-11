import { errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow, Dialog } from 'electron';

interface WindowCloseOptions {
    close: () => void;
    confirm: (runningCount: number) => Promise<'cancel' | 'close' | 'terminate'>;
    countRunning: () => Promise<number>;
    /**
     * Closing the window destroys the Renderer and its unsaved Editor buffers, so they are decided first, exactly as on
     * quit (issue caxri#1631).
     */
    decideUnsavedEditors: () => Promise<'cancel' | 'continue'>;
    /**
     * Server replies carry a result the close flow ignores; only rejection matters here.
     */
    detachAll: () => Promise<unknown>;
    logFailure: (message: string) => void;
    terminateAll: () => Promise<unknown>;
}

export interface WindowClosePrompt {
    buttons: [string, string, string];
    cancelId: number;
    defaultId: number;
    detail: string;
    message: string;
    title: string;
    type: 'warning';
}

/**
 * The close-window confirmation. The running count covers every live Terminal and Agent Chat, so the copy says "tasks"
 * like the Quit dialog (`appQuitPrompt`) instead of "Terminals", and it names the outcome rather than the Server
 * process that keeps them alive.
 */
export function windowClosePrompt(runningCount: number): WindowClosePrompt {
    return {
        type: 'warning',
        title: 'Tasks are still running',
        message: `${runningCount} ${runningCount === 1 ? 'task is' : 'tasks are'} still running.`,
        detail: 'Keep Running closes this window and keeps them running in the background. To exit the app, use Quit Caxri and choose whether running tasks should stop.',
        buttons: ['Keep Running', 'Terminate and Close', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
    };
}

export async function confirmWindowClose(
    dialog: Dialog,
    window: BrowserWindow,
    runningCount: number,
    logger: StructuredLogger | undefined,
): Promise<'cancel' | 'close' | 'terminate'> {
    logger?.write('info', logEventCatalog.window.closeConfirmation, {
        fields: { runningTerminals: runningCount },
    });
    const result = await dialog.showMessageBox(window, windowClosePrompt(runningCount));
    logger?.write('info', logEventCatalog.window.closeDecision, {
        fields: { response: result.response },
    });
    if (result.response === 2) return 'cancel';
    return result.response === 1 ? 'terminate' : 'close';
}

/**
 * Completes window closure even when the Server is unavailable during shutdown.
 */
export async function resolveWindowClose(options: WindowCloseOptions): Promise<void> {
    try {
        if ((await options.decideUnsavedEditors()) === 'cancel') return;
        const runningCount = await options.countRunning();
        if (runningCount > 0) {
            const decision = await options.confirm(runningCount);
            if (decision === 'cancel') return;
            if (decision === 'terminate') await options.terminateAll();
            else await options.detachAll();
        } else {
            await options.detachAll();
        }
    } catch (error) {
        options.logFailure(errorMessage(error, 'Unknown close failure'));
    }
    options.close();
}

export function createWindowCloseHandler(options: WindowCloseOptions): () => Promise<void> {
    let pending: Promise<void> | undefined;
    return () => {
        // Coalesces overlapping close requests (e.g. repeated window-close events) onto the same
        // in-flight promise, so this handler returns it directly rather than awaiting it itself.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        pending ??= resolveWindowClose(options).finally(() => {
            pending = undefined;
        });
        return pending;
    };
}

import { logEventCatalog, toWireError } from '@caxri/protocol';
import type { ErrorLogFields, StructuredLogger } from '@caxri/system';
import { errorLogFields } from '@caxri/system';
import type { BrowserWindow, Dialog } from 'electron';

import type { RunningWork } from './confirmations';
import { runningWorkPhrase, runningWorkTotal } from './confirmations';
import { translateMain as t } from './locale';

/**
 * Closed set of window-close stages that can fail; the `stage` field of `window.close_failed`.
 */
type WindowCloseFailureStage =
    'confirm' | 'countRunning' | 'detach' | 'notification' | 'terminate' | 'unsavedEditors';

interface WindowCloseOptions {
    close: () => void;
    confirm: (running: RunningWork) => Promise<'cancel' | 'close' | 'terminate'>;
    countRunning: () => Promise<RunningWork>;
    /**
     * Closing the window destroys the Renderer and its unsaved Editor buffers, so they are decided first, exactly as on
     * quit (issue caxri#1631).
     */
    decideUnsavedEditors: () => Promise<'cancel' | 'continue'>;
    /**
     * Server replies carry a result the close flow ignores; only rejection matters here.
     */
    detachAll: () => Promise<unknown>;
    /**
     * `code` is the wire error code, so the caller can log expected Server loss (`UNAVAILABLE`) as a warning.
     */
    logFailure: (stage: WindowCloseFailureStage, fields: ErrorLogFields, code: string) => void;
    /**
     * Tells the user that an explicit Terminate could not stop the running work.
     */
    notifyStopFailure: () => Promise<void>;
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
 * The close-window confirmation. It asks the question the window's close button just posed and names the running work
 * with glossary nouns, Terminals and Chats counted separately (`terminal.runningCount`) so the user can tell a plain
 * shell from an Agent still working. It names the outcome rather than the Server process that keeps them alive, and
 * keeps the three buttons the Quit dialog's wording relies on.
 */
export function windowClosePrompt(running: RunningWork): WindowClosePrompt {
    return {
        type: 'warning',
        title: t('desktop.windowClose.title'),
        /**
         * The question is repeated as the `message` because macOS sheets do not show `title`. Message and detail stay
         * one line each so macOS 26 keeps the sheet centered (see `appQuitPrompt`); the buttons say what each choice
         * does.
         */
        message: t('desktop.windowClose.title'),
        detail: t('desktop.runningWork.detail', { running: runningWorkPhrase(running) }),
        buttons: [
            t('desktop.windowClose.keepRunning'),
            t('desktop.windowClose.terminate'),
            t('desktop.dialog.cancel'),
        ],
        /**
         * Keep Running is the Return target, matching `appQuitPrompt`; a shared default/cancel index would leave no
         * Return target on macOS.
         */
        defaultId: 0,
        cancelId: 2,
    };
}

export async function notifyWindowCloseStopFailure(
    dialog: Dialog,
    window: BrowserWindow | undefined,
): Promise<void> {
    const options = {
        type: 'error' as const,
        title: t('desktop.windowClose.stopFailureTitle'),
        message: t('desktop.windowClose.stopFailureMessage'),
        detail: t('desktop.windowClose.stopFailureDetail'),
        buttons: [t('desktop.windowClose.closeAnyway')],
        defaultId: 0,
        cancelId: 0,
    };
    if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
}

export async function confirmWindowClose(
    dialog: Dialog,
    window: BrowserWindow,
    running: RunningWork,
    logger: StructuredLogger | undefined,
): Promise<'cancel' | 'close' | 'terminate'> {
    logger?.write('info', logEventCatalog.window.closeConfirmation, {
        fields: { runningChats: running.chats, runningTerminals: running.terminals },
    });
    const result = await dialog.showMessageBox(window, windowClosePrompt(running));
    logger?.write('info', logEventCatalog.window.closeDecision, {
        fields: { response: result.response },
    });
    if (result.response === 2) return 'cancel';
    return result.response === 1 ? 'terminate' : 'close';
}

/**
 * Completes window closure even when the Server is unavailable during shutdown. Each stage fails on its own so the log
 * says which one broke (`window.close_failed` `stage`):
 *
 * - `unsavedEditors`, `countRunning`, `confirm`, and `detach` fail open: the window still closes, because keeping work
 *   alive (or asking nothing) is the safe outcome and a wedged Server must not trap the window open.
 * - `terminate` is different: the user explicitly chose to end the running work. If the Server cannot do it, the window
 *   still closes (matching the quit path) but the user is told that the work is still running, so a closed window never
 *   silently implies termination.
 */
export async function resolveWindowClose(options: WindowCloseOptions): Promise<void> {
    const fail = (stage: WindowCloseFailureStage, error: unknown): void => {
        options.logFailure(stage, errorLogFields(error), toWireError(error).code);
    };
    let decision: 'cancel' | 'close' | 'terminate' = 'close';
    let running: RunningWork | undefined;
    try {
        if ((await options.decideUnsavedEditors()) === 'cancel') return;
    } catch (error) {
        fail('unsavedEditors', error);
    }
    try {
        running = await options.countRunning();
    } catch (error) {
        fail('countRunning', error);
    }
    if (running && runningWorkTotal(running) > 0) {
        try {
            decision = await options.confirm(running);
        } catch (error) {
            fail('confirm', error);
        }
        if (decision === 'cancel') return;
    }
    if (decision === 'terminate') {
        try {
            await options.terminateAll();
        } catch (error) {
            fail('terminate', error);
            try {
                await options.notifyStopFailure();
            } catch (notifyError) {
                fail('notification', notifyError);
            }
        }
    } else {
        try {
            await options.detachAll();
        } catch (error) {
            fail('detach', error);
        }
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

import { errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow, Dialog } from 'electron';

import type { RunningWork } from './confirmations';
import { runningWorkPhrase, runningWorkTotal } from './confirmations';
import { translateMain as t } from './locale';

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
         * The question lives in `message` because macOS sheets do not show `title`; the title is only for platforms
         * that draw one.
         */
        message: t(
            runningWorkTotal(running) === 1
                ? 'desktop.windowClose.messageOne'
                : 'desktop.windowClose.messageOther',
            { running: runningWorkPhrase(running) },
        ),
        detail: t('desktop.windowClose.detail'),
        buttons: [
            t('desktop.windowClose.keepRunning'),
            t('desktop.windowClose.terminate'),
            t('desktop.dialog.cancel'),
        ],
        defaultId: 2,
        cancelId: 2,
    };
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
 * Completes window closure even when the Server is unavailable during shutdown.
 */
export async function resolveWindowClose(options: WindowCloseOptions): Promise<void> {
    try {
        if ((await options.decideUnsavedEditors()) === 'cancel') return;
        const running = await options.countRunning();
        if (runningWorkTotal(running) > 0) {
            const decision = await options.confirm(running);
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

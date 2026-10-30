import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { app, dialog } from 'electron';

import type { AppQuitIntent } from './app-quit';
import { createAppQuitHandler, createAppQuitPromptOptions, readAppQuitStatus } from './app-quit';
import { persistAllWindowState } from './auxiliary-window/lifecycle';
import type { CaxriBotWindowController } from './caxri-bot-window';
import type { DesktopServerConnection } from './connection/server-connection';
import type { ProcessExplorerWindowController } from './process-explorer/window';
import type { SshHostEnvironments } from './ssh/host-environments';
import type { createWorkbenchUnsavedEditors } from './unsaved-editors';
import { readWindowState } from './window-placement';

interface MainQuitWiringOptions {
    caxriBot(): CaxriBotWindowController | undefined;
    /**
     * Starts a staged in-place update right before Main exits; see `AppQuitOptions.applyUpdate`. Resolves whether the
     * installer started.
     */
    applyUpdate(options: { relaunch: boolean }): Promise<boolean>;
    /**
     * The window a quit prompt attaches to.
     */
    focusedWindow: () => BrowserWindow | undefined;
    logger(): StructuredLogger | undefined;
    mainWindow(): BrowserWindow | undefined;
    /**
     * Runs once the user accepted the quit, before anything is torn down: Main marks itself as quitting here.
     */
    onAccepted(): void;
    processExplorer(): ProcessExplorerWindowController;
    quitIntent: () => AppQuitIntent;
    sshHostEnvironments(): SshHostEnvironments | undefined;
    /**
     * Unset until Server Core is attached, so a quit before then must not touch it.
     */
    supervisor(): DesktopServerConnection | undefined;
    unsavedEditors: ReturnType<typeof createWorkbenchUnsavedEditors>;
}

/**
 * What the next quit is for: `user` until a flow that starts a quit (a relaunch, Restart to Update, a system shutdown)
 * marks it, and back to `user` when that flow's quit is cancelled.
 */
export function createQuitIntent() {
    let intent: AppQuitIntent = 'user';
    return {
        current: (): AppQuitIntent => intent,
        set: (next: AppQuitIntent): void => {
            intent = next;
        },
    };
}

/**
 * Composes Main's quit handler from the live window and connection state the composition root owns.
 */
export function createMainQuitHandler(options: MainQuitWiringOptions) {
    /**
     * Only reached after `supervisor()` was checked or the connection is known to exist (a quit decided after ready).
     */
    const server = (): DesktopServerConnection => options.supervisor()!;
    return createAppQuitHandler({
        applyUpdate: async (update) => {
            let isInstalling = false;
            try {
                isInstalling = await options.applyUpdate(update);
            } finally {
                // The installer reopens Caxri itself. Without one, a confirmed restart must still reopen the old build
                // rather than leave the user with no app; the failure itself is reported by the quit flow.
                if (!isInstalling && update.relaunch) app.relaunch();
            }
        },
        acceptQuit: () => {
            options.onAccepted();
            options.supervisor()?.markQuitting();
        },
        closeDesktop: async () => {
            await options.sshHostEnvironments()?.detachAll();
            await server().shutdown();
        },
        ...createAppQuitPromptOptions(dialog, options.focusedWindow),
        decideUnsavedEditors: () => options.unsavedEditors.decide('quit'),
        detachAll: async () => {
            await options.sshHostEnvironments()?.detachTerminals();
            return server().request('terminal.detachAll');
        },
        exit: () => app.exit(0),
        logFailure: (level, stage, error) =>
            options.logger()?.write(level, logEventCatalog.app.quitFailed, {
                fields: { stage, error },
            }),
        persistWindowState: async () => {
            const window = options.mainWindow();
            await persistAllWindowState([
                () =>
                    window && !window.isDestroyed()
                        ? server().request('app.windowState.update', readWindowState(window))
                        : undefined,
                () => options.caxriBot()?.persistWindowState(),
                () => options.processExplorer().persistWindowState(),
            ]);
        },
        quitIntent: options.quitIntent,
        readPendingReviewComments: () => server().request('gitReview.pending', {}),
        readStatus: () => readAppQuitStatus(server()),
        stopServer: () => server().stopServer(),
    });
}

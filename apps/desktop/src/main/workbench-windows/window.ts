import { join } from 'node:path';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { app, BrowserWindow, dialog, nativeTheme } from 'electron';

import type { RunningWork } from '../confirmations';
import type { DesktopServerConnection } from '../connection/server-connection';
import { loadRendererEntry } from '../renderer-entry';
import type { RendererReadiness } from '../renderer-readiness';
import type { StartupProfile } from '../startup-profile';
import {
    mainWindowChromeOptions,
    publishFullScreenState,
    zoomFactorForLevel,
} from '../window-chrome';
import { confirmWindowClose, createWindowCloseHandler } from '../window-close';
import type { E2EWindowMode } from '../window-mode';
import type { WindowPlacement } from '../window-placement';
import { defaultWindowState, showWhenPlaced, trackWindowState } from '../window-placement';
import { installWorkbenchRendererGuards } from '../workbench-renderer-guards';

/**
 * Whether a Workbench window is the primary window (`main`, with the persisted geometry, the startup profile, and the
 * Terminal-aware close flow) or a tear-off window (a Session tab dragged out, with a Main-minted key and no persistence
 * of its own).
 */
export type WorkbenchWindowRole = 'primary' | 'tearOff';

export interface WorkbenchWindowFactoryOptions {
    bootStartedAt: number;
    currentDirectory: string;
    e2eWindowMode: E2EWindowMode;
    eventRelay: { rendererPending(windowKey: string): void };
    isQuitting: () => boolean;
    logger: () => StructuredLogger | undefined;
    /**
     * Runs once after the primary window first paints.
     */
    onPrimaryReadyToShow: () => void;
    /**
     * Runs after any Workbench window closes, with what the close was. The caller unregisters the window.
     */
    onClosed: (info: {
        role: WorkbenchWindowRole;
        windowKey: string;
        window: BrowserWindow;
    }) => void;
    /**
     * Closes the tear-off windows without releasing their strips, once the primary window's close was decided.
     */
    closeTearOffsKeepingStrips: () => void;
    /**
     * The profile's diagnostic log folder, revealed by the Renderer crash-loop dialog.
     */
    logDirectory: string;
    rendererReadiness: RendererReadiness;
    sendEvent: (event: ServerEvent, windowKey?: string) => void;
    startupProfile: StartupProfile;
    supervisor: () => DesktopServerConnection;
    /**
     * Decides unsaved Editor buffers: every window's when `windowKey` is omitted (the primary window closing takes the
     * torn-off windows with it), one window's otherwise.
     */
    decideUnsavedEditors: (windowKey?: string) => Promise<'cancel' | 'continue'>;
    zoomLevel: () => number;
}

/**
 * Builds the Workbench window creator shared by the primary window and the tear-off windows, so both get the same
 * hardening, zoom, chrome, and renderer entry. Only the persistence and close behavior differ by role.
 */
export function createWorkbenchWindowFactory(options: WorkbenchWindowFactoryOptions) {
    const { logger, supervisor } = options;
    return function createWorkbenchWindow(input: {
        role: WorkbenchWindowRole;
        windowKey: string;
        placement: Promise<WindowPlacement>;
    }): BrowserWindow {
        const { role, windowKey, placement } = input;
        const zoomFactor = zoomFactorForLevel(options.zoomLevel());
        const window = new BrowserWindow({
            ...defaultWindowState.bounds,
            minWidth: 960,
            minHeight: 640,
            title: 'Caxri',
            ...mainWindowChromeOptions(
                zoomFactor,
                process.platform,
                nativeTheme.shouldUseDarkColors,
            ),
            show: false,
            webPreferences: {
                preload: join(options.currentDirectory, '../preload/index.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                /**
                 * The window stays hidden while it loads in parallel with Server Core startup; an unthrottled page
                 * reaches its first paint, and so `ready-to-show`, without waiting for visibility. Throttling returns
                 * once the window is shown.
                 */
                backgroundThrottling: false,
                zoomFactor,
            },
        });
        const isPrimary = role === 'primary';
        options.eventRelay.rendererPending(windowKey);
        options.rendererReadiness.track(window.webContents);
        window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame) options.eventRelay.rendererPending(windowKey);
        });
        // Only the primary window persists geometry: a tear-off window restores at a cascade offset (bounds are deferred).
        const windowState = isPrimary
            ? trackWindowState(window, {
                  isQuitting: options.isQuitting,
                  // Fire and forget: a failed persist is not user-actionable here.
                  save: (state) => {
                      const update = supervisor().request('app.windowState.update', state);
                      // eslint-disable-next-line unicorn/prefer-await -- fire and forget
                      update.catch(() => {});
                  },
              })
            : undefined;
        publishFullScreenState(window, 'workbench', options.sendEvent, windowKey);
        if (isPrimary) options.startupProfile.mark('windowCreated');
        logger()?.write('info', logEventCatalog.window.created);
        window.once('ready-to-show', () => {
            if (!isPrimary) return;
            options.startupProfile.mark('readyToShow');
            logger()?.write('info', logEventCatalog.window.readyToShow, {
                durationMs: performance.now() - options.bootStartedAt,
            });
            options.onPrimaryReadyToShow();
        });
        showWhenPlaced(window, placement, () => {
            if (isPrimary) options.startupProfile.mark('windowShown');
            window.webContents.setBackgroundThrottling(true);
            if (options.e2eWindowMode === 'visible') window.show();
        });
        installWorkbenchRendererGuards(window, {
            isQuitting: options.isQuitting,
            logDirectory: options.logDirectory,
            logger,
            shutdown: () => supervisor().shutdown(),
        });
        let isForceClose = false;
        const closeNow = (): void => {
            isForceClose = true;
            window.close();
            isForceClose = false;
        };
        // eslint-disable-next-line unicorn/prefer-minimal-ternary -- the two handlers differ in most options
        const requestWindowClose = isPrimary
            ? createWindowCloseHandler({
                  close: () => {
                      options.closeTearOffsKeepingStrips();
                      closeNow();
                  },
                  confirm: (running: RunningWork) =>
                      confirmWindowClose(dialog, window, running, logger()),
                  countRunning: () => supervisor().request('terminal.runningCount'),
                  decideUnsavedEditors: () => options.decideUnsavedEditors(),
                  detachAll: () => supervisor().request('terminal.detachAll'),
                  logFailure: (message) =>
                      logger()?.write('error', logEventCatalog.window.closeFailed, {
                          fields: { error: message },
                      }),
                  terminateAll: () => supervisor().request('terminal.terminateAll'),
              })
            : /**
               * A tear-off window closes like a tab: its unsaved Editor buffers are decided, then its strip is released. It never
               * prompts about or touches Terminals, because its Sessions keep running and simply leave the working set.
               */
              createWindowCloseHandler({
                  close: closeNow,
                  confirm: () => Promise.resolve('close'),
                  countRunning: () => Promise.resolve({ chats: 0, terminals: 0 }),
                  decideUnsavedEditors: () => options.decideUnsavedEditors(windowKey),
                  detachAll: () => Promise.resolve(),
                  logFailure: (message) =>
                      logger()?.write('error', logEventCatalog.window.closeFailed, {
                          fields: { error: message },
                      }),
                  terminateAll: () => Promise.resolve(),
              });
        window.on('close', (event) => {
            if (isForceClose || options.isQuitting()) return;
            windowState?.flush();
            event.preventDefault();
            // `close` is a synchronous listener; the handler already resolves the window's fate
            // (confirm/terminate/close) internally, so this is deliberately fire-and-forget here.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            requestWindowClose().catch(() => {});
        });
        window.on('closed', () => {
            windowState?.cancel();
            options.onClosed({ role, windowKey, window });
            logger()?.write('info', logEventCatalog.window.closed);
        });
        loadRendererEntry(window, {
            currentDirectory: options.currentDirectory,
            isPackaged: app.isPackaged,
            page: 'index.html',
            rendererUrl: process.env.ELECTRON_RENDERER_URL,
        });
        return window;
    };
}

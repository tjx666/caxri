import type { PersistedWindowState } from '@caxri/protocol';
import { errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { DesktopServerConnection } from './server-connection';
import type { TearOffPoint, TearOffRect, TearOffWindowHandle } from './tear-off';
import { cascadedBounds, createTearOffController } from './tear-off';
import type { WindowPlacement } from './window-placement';
import { PRIMARY_WINDOW_KEY } from './window-presence-registry';
import type { WorkbenchWindowLike, WorkbenchWindows } from './workbench-windows';

/**
 * The slice of a Workbench `BrowserWindow` tear-off needs, so the lifecycle runs under Vitest without Electron.
 */
export interface TearOffBrowserWindow extends WorkbenchWindowLike, TearOffWindowHandle {
    getBounds(): TearOffRect;
    getNormalBounds(): TearOffRect;
    webContents: WorkbenchWindowLike['webContents'];
}

export interface TearOffWindowsOptions<W extends TearOffBrowserWindow> {
    /**
     * Creates a hidden tear-off Workbench window that shows once `placement` resolves (and stays hidden if it rejects).
     */
    createWindow(input: { windowKey: string; placement: Promise<WindowPlacement> }): W;
    cursorPoint: () => TearOffPoint;
    logger: () => StructuredLogger | undefined;
    /**
     * Registers a new window's native presence and, with `sessionId`, the Session it renders.
     */
    register: (windowKey: string, window: W, sessionId: string | null) => void;
    /**
     * Resolves when the primary window's Renderer is ready, so restored windows cascade from its final bounds.
     */
    primaryReady: (primary: W) => Promise<unknown>;
    serverReady: Promise<unknown>;
    supervisor: () => Pick<DesktopServerConnection, 'request'>;
    windows: Pick<WorkbenchWindows<W>, 'get' | 'list' | 'remove'>;
    workAreas: () => TearOffRect[];
    zoomLevel: () => number;
}

/**
 * Everything Main does for tear-off windows beyond the shared window factory: the drag-out gesture, closing, and
 * restoring them at launch.
 *
 * Closing a tear-off releases its Open Sessions (like closing a tab), except when the primary window closes or the app
 * quits: then the strips stay stored and the windows come back on the next launch. A window whose Server move failed
 * never had a strip, so it is discarded without a release.
 */
export function createTearOffWindows<W extends TearOffBrowserWindow>(
    options: TearOffWindowsOptions<W>,
) {
    const { logger, windows } = options;
    const keepStripKeys = new Set<string>();

    function createTearOffWindow(input: {
        windowKey: string;
        sessionId: string | null;
        bounds: NonNullable<PersistedWindowState['bounds']>;
        gate: Promise<void>;
    }): W {
        const window = options.createWindow({
            windowKey: input.windowKey,
            // eslint-disable-next-line unicorn/prefer-await -- the placement is a promise handed to the window
            placement: input.gate.then(() => ({
                state: { bounds: input.bounds, isMaximized: false, isFullScreen: false },
                zoomLevel: options.zoomLevel(),
            })),
        });
        options.register(input.windowKey, window, input.sessionId);
        return window;
    }

    const controller = createTearOffController<W>({
        createWindow: ({ placement, windowKey, sessionId, bounds }) =>
            createTearOffWindow({ windowKey, sessionId, bounds, gate: placement }),
        cursorPoint: options.cursorPoint,
        discardWindow: (windowKey) => {
            keepStripKeys.add(windowKey);
            windows.remove(windowKey);
        },
        logger,
        moveSession: ({ sourceKey, targetKey, sessionId }) =>
            options.supervisor().request('window.openSessions.moveToWindow', {
                sessionId,
                windowKey: sourceKey,
                targetWindowKey: targetKey,
            }),
        otherBounds: (excludeKey) =>
            windows
                .list()
                .filter(({ key }) => key !== excludeKey)
                .map(({ window }) => window.getBounds()),
        sourceBounds: (windowKey) => {
            const window = windows.get(windowKey);
            return window && { bounds: window.getBounds(), size: window.getNormalBounds() };
        },
        workAreas: options.workAreas,
    });

    return {
        tearOff: (input: Parameters<typeof controller.tearOff>[0]) => controller.tearOff(input),
        /**
         * Destroys every tear-off window without releasing its strip: the primary window closed, so they restore with
         * it.
         */
        closeKeepingStrips(): void {
            for (const { key, window } of windows.list()) {
                if (key === PRIMARY_WINDOW_KEY) continue;
                keepStripKeys.add(key);
                window.destroy();
            }
        },
        /**
         * A tear-off window closed. Releases its strip on the Server unless the app is quitting or the close was a
         * keep-strip close.
         */
        onClosed(windowKey: string, isQuitting: boolean): void {
            const isKept = keepStripKeys.delete(windowKey);
            if (isQuitting || isKept) return;
            logger()?.write('info', logEventCatalog.window.tearOffReleased);
            // A failed release leaves a stored strip that restores on the next launch, so it is not retried.
            const release = options
                .supervisor()
                .request('window.openSessions.release', { windowKey });
            // eslint-disable-next-line unicorn/prefer-await -- fire and forget
            release.catch(() => {});
        },
        /**
         * Reopens the torn-off windows the Server still has strips for, cascaded from the primary window. Per-window
         * bounds are not persisted yet.
         */
        async restore(primary: W): Promise<void> {
            try {
                await options.serverReady;
                await options.primaryReady(primary);
                const records = await options
                    .supervisor()
                    .request('window.openSessions.listTearOffs', {});
                const restorable = records.filter(({ windowKey }) => !windows.get(windowKey));
                const workAreas = options.workAreas();
                for (const [index, record] of restorable.entries())
                    createTearOffWindow({
                        windowKey: record.windowKey,
                        sessionId: record.activeSessionId,
                        bounds: cascadedBounds(primary.getBounds(), index, workAreas),
                        gate: Promise.resolve(),
                    });
                if (restorable.length > 0)
                    logger()?.write('info', logEventCatalog.window.tearOffRestored, {
                        fields: { count: restorable.length },
                    });
            } catch (error) {
                logger()?.write('warn', logEventCatalog.window.tearOffRestoreFailed, {
                    fields: { error: errorMessage(error, 'unknown') },
                });
            }
        },
    };
}

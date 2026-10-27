import type { LogEventName } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { BrowserWindow } from 'electron';

import { isBenignRendererErrorMessage } from '../shared/renderer-error-policy';
import { consoleErrorLogFields } from './console-error-fields';
import { decideCrashRecovery } from './crash-policy';
import { observeRendererHangs } from './renderer-hang-observer';

/**
 * Log events one auxiliary window writes for its own Renderer lifecycle. Each window keeps a distinct catalog group so
 * a crash loop in an optional window is never mistaken for the Workbench's.
 */
interface AuxiliaryWindowLogEvents {
    consoleError: LogEventName;
    preloadError: LogEventName;
    renderProcessCrashLoop: LogEventName;
    renderProcessGone: LogEventName;
    responsive: LogEventName;
    unresponsive: LogEventName;
}

export interface AuxiliaryWindowOptions {
    browserWindow: BrowserWindowConstructorOptions;
    events: AuxiliaryWindowLogEvents;
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Immutable entry URL; navigation to anything else is refused and crash recovery reloads exactly this URL.
     */
    rendererUrl: string;
    showOnReady: boolean;
}

/**
 * Creates one optional, single-purpose Electron window (Process Explorer, Caxri Bot) with the shared hardening every
 * auxiliary window needs: denied `window.open`, navigation pinned to the immutable entry URL, console and preload error
 * logging, hang observation, and bounded crash recovery that destroys only the failed window after a crash loop.
 *
 * The caller owns single-instance focus and its own IPC; this helper owns only the window's Renderer lifecycle.
 */
export function createAuxiliaryWindow(options: AuxiliaryWindowOptions): BrowserWindow {
    const { events, logger, rendererUrl } = options;
    const window = new BrowserWindow({ ...options.browserWindow, show: false });
    let crashTimestampsMs: number[] = [];
    window.once('ready-to-show', () => {
        if (options.showOnReady) window.show();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
        /**
         * A crashed WebContents may no longer report its current URL. Compare against the immutable entry URL so
         * recovery is allowed without widening navigation privileges.
         */
        if (url === rendererUrl) return;
        event.preventDefault();
    });
    window.webContents.on('console-message', (details) => {
        if (details.level !== 'error' || isBenignRendererErrorMessage(details.message)) return;
        logger.write('error', events.consoleError, { fields: consoleErrorLogFields(details) });
    });
    window.webContents.on('preload-error', () => {
        logger.write('error', events.preloadError, { fields: { code: 'PRELOAD_ERROR' } });
    });
    observeRendererHangs(
        window.webContents,
        events,
        () => logger,
        () => !window.isDestroyed(),
    );
    window.webContents.on('render-process-gone', (_event, details) => {
        if (details.reason === 'clean-exit' || window.isDestroyed()) return;
        const recovery = decideCrashRecovery(crashTimestampsMs, Date.now());
        crashTimestampsMs = recovery.crashTimestampsMs;
        const { decision } = recovery;
        if (decision.action === 'reload') {
            logger.write('warn', events.renderProcessGone, {
                fields: {
                    code: 'RENDER_PROCESS_GONE',
                    reason: details.reason,
                    crashCount: decision.crashCount,
                    delayMs: decision.delayMs ?? 0,
                },
            });
            setTimeout(() => {
                if (!window.isDestroyed())
                    // `render-process-gone` recovery reload is best-effort: a failed reload here re-triggers this same
                    // crash-recovery handler on the next crash event, so it is deliberately fire-and-forget.
                    // eslint-disable-next-line unicorn/prefer-await -- see comment above
                    window.loadURL(rendererUrl).catch(() => {});
            }, decision.delayMs);
            return;
        }
        logger.write('error', events.renderProcessCrashLoop, {
            fields: {
                code: 'RENDER_PROCESS_CRASH_LOOP',
                reason: details.reason,
                crashCount: decision.crashCount,
            },
        });
        /**
         * An auxiliary window is optional, so stop only its failed window. Creating the next window starts a fresh
         * crash history and leaves the healthy Workbench untouched.
         */
        window.destroy();
    });
    // The window is created synchronously and returned before navigation settles; load failures surface through the
    // 'render-process-gone'/'preload-error' handlers above, so this is deliberately fire-and-forget.
    // eslint-disable-next-line unicorn/prefer-await -- see comment above
    window.loadURL(rendererUrl).catch(() => {});
    return window;
}

/**
 * Wires an auxiliary window's `moved`/`resized`/`close` events to remember its normal bounds. Shared by the Agent Caxri
 * Bot and Process Explorer controllers so this wiring, and the display-clamped restore it feeds
 * (`auxiliary-window-bounds.ts`), exist in exactly one place instead of two near-identical copies. `close` also covers
 * a crash-like destroy that never reaches `moved`/`resized` again.
 */
export function trackAuxiliaryWindowBounds(
    window: BrowserWindow,
    remember: (bounds: Rectangle) => void,
): void {
    const onChange = (): void => {
        if (!window.isDestroyed()) remember(window.getNormalBounds());
    };
    window.on('moved', onChange);
    window.on('resized', onChange);
    window.on('close', onChange);
}

/**
 * Restores and, in a visible launch, raises an existing auxiliary window. Returns false when the caller must create a
 * new one.
 */
export function isAuxiliaryWindowRevealed(
    window: BrowserWindow | undefined,
    isVisibleMode: boolean,
): window is BrowserWindow {
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    if (isVisibleMode) {
        window.show();
        window.focus();
    }
    return true;
}

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { app, dialog, shell } from 'electron';

import { decideCrashRecovery } from './crash-policy';
import { translateMain } from './locale';

/**
 * Reloads a crashed Workbench Renderer with backoff and, once it is crash-looping, asks whether to relaunch or quit.
 */
export function observeRendererCrashes(
    window: BrowserWindow,
    options: {
        /**
         * True once Main accepted a quit. A Renderer killed by the same teardown (a termination signal reaches every
         * Chromium child at once) is not a crash: reloading it would start a fresh Workbench against a dying Server.
         */
        isQuitting: () => boolean;
        /**
         * The profile's diagnostic log folder (`DesktopProfile.logDirectory`), revealed by "Reveal Logs in Finder".
         */
        logDirectory: string;
        logger: () => StructuredLogger | undefined;
        shutdown: () => Promise<void>;
    },
): void {
    let rendererCrashTimestampsMs: number[] = [];
    window.webContents.on('render-process-gone', (_event, details) => {
        if (details.reason === 'clean-exit' || window.isDestroyed()) return;
        if (options.isQuitting()) {
            options.logger()?.write('info', logEventCatalog.window.renderProcessGone, {
                fields: {
                    code: 'RENDER_PROCESS_GONE',
                    reason: details.reason,
                    exitCode: details.exitCode,
                    source: 'app-quitting',
                },
            });
            return;
        }
        const { decision, crashTimestampsMs } = decideCrashRecovery(
            rendererCrashTimestampsMs,
            Date.now(),
        );
        rendererCrashTimestampsMs = crashTimestampsMs;
        if (decision.action === 'reload') {
            options.logger()?.write('warn', logEventCatalog.window.renderProcessGone, {
                fields: {
                    code: 'RENDER_PROCESS_GONE',
                    reason: details.reason,
                    exitCode: details.exitCode,
                    crashCount: decision.crashCount,
                    delayMs: decision.delayMs ?? 0,
                },
            });
            setTimeout(() => {
                if (!window.isDestroyed()) window.reload();
            }, decision.delayMs);
            return;
        }
        options.logger()?.write('error', logEventCatalog.window.renderProcessCrashLoop, {
            fields: {
                code: 'RENDER_PROCESS_CRASH_LOOP',
                reason: details.reason,
                exitCode: details.exitCode,
                crashCount: decision.crashCount,
            },
        });
        // `render-process-gone` is a synchronous listener; recovering from a repeated crash by
        // relaunching or exiting cannot block this handler, so the recovery flow below is
        // deliberately fire-and-forget rather than awaited.
        (async () => {
            let response: number;
            do {
                // eslint-disable-next-line no-await-in-loop -- the dialog re-opens after Reveal Logs until a final choice
                ({ response } = await dialog.showMessageBox(window, {
                    type: 'error',
                    title: translateMain('desktop.crash.title'),
                    message: translateMain('desktop.crash.message'),
                    detail: translateMain('desktop.crash.detail'),
                    buttons: [
                        translateMain('desktop.crash.relaunch'),
                        translateMain('desktop.crash.revealLogs'),
                        translateMain('desktop.crash.quit'),
                    ],
                    defaultId: 0,
                    cancelId: 2,
                }));
                // eslint-disable-next-line no-await-in-loop -- sequential with the dialog
                if (response === 1) await shell.openPath(options.logDirectory);
            } while (response === 1);
            try {
                await options.shutdown();
            } catch {
                // Best-effort shutdown; the window still needs to relaunch or exit below.
            }
            if (response === 0) app.relaunch();
            app.exit(0);
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
        })().catch(() => {});
    });
}

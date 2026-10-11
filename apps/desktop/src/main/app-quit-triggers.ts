import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { App } from 'electron';

import type { AppQuitOutcome, AppQuitSignal } from './app-quit';

export interface AppQuitTriggerOptions {
    app: Pick<App, 'exit' | 'on'>;
    isQuitStarted: () => boolean;
    logger: () => StructuredLogger | undefined;
    /**
     * The coalescing handler from `createAppQuitHandler`; a `signal` argument bypasses a pending quit prompt.
     */
    requestAppQuit: (signal?: AppQuitSignal) => Promise<AppQuitOutcome>;
}

const QUIT_SIGNALS: readonly AppQuitSignal[] = ['SIGINT', 'SIGTERM'];

/**
 * Routes Electron's `before-quit` (Cmd+Q, the app menu, `app.quit()`) through the quit handler. The default is always
 * prevented because the handler, not Electron, decides when Main exits.
 */
export function installBeforeQuitTrigger(options: AppQuitTriggerOptions): void {
    options.app.on('before-quit', (event) => {
        event.preventDefault();
        if (options.isQuitStarted()) return;
        options.logger()?.write('info', logEventCatalog.app.quitRequested);
        // Coalesce repeated Cmd+Q events and commit shutdown only after the user accepts.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        options.requestAppQuit().catch(() => options.app.exit(0));
    });
}

/**
 * Install only once the Server connection exists because acceptance fences its recovery. A Node listener replaces
 * Electron's default handler, which routes the signal through `before-quit` and so joins a pending quit prompt instead
 * of quitting; see `resolveSignalQuit`.
 */
export function installSignalQuitTriggers(
    options: AppQuitTriggerOptions,
    target: Pick<NodeJS.Process, 'on'> = process,
): void {
    for (const signal of QUIT_SIGNALS)
        target.on(signal, () => {
            options.logger()?.write('info', logEventCatalog.app.quitRequested, {
                fields: { trigger: signal, isQuitStarted: options.isQuitStarted() },
            });
            // A signal listener cannot await teardown; every quit stage already fails open to `app.exit`.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            options.requestAppQuit(signal).catch(() => options.app.exit(0));
        });
}

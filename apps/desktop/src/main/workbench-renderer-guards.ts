import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';

import { isBenignRendererErrorMessage } from '../shared/renderer-error-policy';
import { consoleErrorLogFields } from './console-error-fields';
import { observeRendererCrashes } from './renderer-crash-recovery';
import { observeRendererHangs } from './renderer-hang-observer';

/**
 * Locks a Workbench Renderer to its own page and mirrors its console errors, preload failures, and hangs into Main's
 * log. Shared by the local Workbench window and every SSH Host window; `window` tags the console errors of the latter.
 */
export function installRendererGuards(
    window: BrowserWindow,
    options: { logger: () => StructuredLogger | undefined; window?: 'ssh-host' },
): void {
    /**
     * Passive page content never inherits authority from an explicitly trusted Terminal link.
     */
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
        if (url !== window.webContents.getURL()) event.preventDefault();
    });
    /**
     * Renderer console errors are otherwise invisible in logs; mirror them so triage can see UI faults.
     */
    window.webContents.on('console-message', (details) => {
        if (details.level !== 'error' || isBenignRendererErrorMessage(details.message)) return;
        options.logger()?.write('error', logEventCatalog.renderer.consoleError, {
            fields: {
                ...consoleErrorLogFields(details),
                ...(options.window && { window: options.window }),
            },
        });
    });
    window.webContents.on('preload-error', () => {
        options.logger()?.write('error', logEventCatalog.renderer.preloadError, {
            fields: { code: 'PRELOAD_ERROR' },
        });
    });
    observeRendererHangs(window.webContents, logEventCatalog.window, options.logger);
}

/**
 * The local Workbench window's guards plus crash recovery, which may shut the local Server down through
 * `observeRendererCrashes`. SSH Host windows install only `installRendererGuards`: their Server is not this Desktop's.
 */
export function installWorkbenchRendererGuards(
    window: BrowserWindow,
    options: Parameters<typeof observeRendererCrashes>[1],
): void {
    installRendererGuards(window, { logger: options.logger });
    observeRendererCrashes(window, options);
}

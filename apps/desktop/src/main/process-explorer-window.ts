import { join } from 'node:path';

import type { RendererErrorKind, ThemeTokens } from '@caxri/protocol';
import { isRendererErrorKind, RENDERER_ERROR_CHANNELS } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';

import type { ProcessExplorerSnapshot } from '../shared/process-explorer';
import { processExplorerSnapshotSchema } from '../shared/process-explorer';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import { createAuxiliaryWindow, isAuxiliaryWindowRevealed } from './auxiliary-window';
import type { ProcessExplorerSampler } from './process-explorer';
import {
    assertTrustedProcessExplorerSender,
    resolveProcessExplorerRendererUrl,
} from './process-explorer-window-helpers';
import type { E2EWindowMode } from './window-mode';

interface ProcessExplorerWindowOptions {
    currentDirectory: string;
    /**
     * E2E-only render-exception seam; Main never enables it in normal launches.
     */
    forceRenderError?: boolean;
    logger: StructuredLogger;
    isPackaged: boolean;
    rendererUrl?: string;
    sampler: ProcessExplorerSampler;
    theme: () => Promise<ThemeTokens>;
    windowMode: E2EWindowMode;
}

export class ProcessExplorerWindowController {
    private window?: BrowserWindow;

    constructor(private readonly options: ProcessExplorerWindowOptions) {}

    installIpc(): void {
        ipcMain.on(RENDERER_ERROR_CHANNELS.processExplorer, (event, rawKind: unknown) => {
            if (!this.window || event.sender !== this.window.webContents) return;
            if (!isRendererErrorKind(rawKind)) return;
            const kind: RendererErrorKind = rawKind;
            this.options.logger.write(
                'error',
                kind === 'page-exception'
                    ? logEventCatalog.processExplorer.pageException
                    : logEventCatalog.processExplorer.unhandledRejection,
                {
                    fields: {
                        code: kind === 'page-exception' ? 'PAGE_EXCEPTION' : 'UNHANDLED_REJECTION',
                    },
                },
            );
        });
        ipcMain.handle(
            PROCESS_EXPLORER_CHANNELS.snapshot,
            async (event): Promise<ProcessExplorerSnapshot> => {
                assertTrustedProcessExplorerSender(this.window?.webContents, event.sender);
                const startedAt = performance.now();
                const snapshot = processExplorerSnapshotSchema.parse(
                    await this.options.sampler.snapshot(),
                );
                this.options.logger.write('debug', logEventCatalog.processExplorer.sample, {
                    durationMs: performance.now() - startedAt,
                    fields: { processes: snapshot.processes.length },
                });
                return snapshot;
            },
        );
        ipcMain.handle(PROCESS_EXPLORER_CHANNELS.theme, (event) => {
            assertTrustedProcessExplorerSender(this.window?.webContents, event.sender);
            return this.options.theme();
        });
    }

    /**
     * OS process id of this window's renderer, or `undefined` while it is closed. The sampler uses it to label Caxri's
     * two renderer processes by role; Electron's `getAppMetrics()` reports no name for `Tab` processes, so the
     * diagnostics window could not otherwise identify itself.
     */
    processId(): number | undefined {
        if (!this.window || this.window.isDestroyed()) return undefined;
        return this.window.webContents.getOSProcessId();
    }

    open(): void {
        if (isAuxiliaryWindowRevealed(this.window, this.options.windowMode === 'visible')) return;
        const window = createAuxiliaryWindow({
            browserWindow: {
                width: 1_280,
                height: 760,
                minWidth: 720,
                minHeight: 420,
                title: 'Process Explorer — Caxri',
                backgroundColor: '#282a36',
                titleBarStyle: 'hiddenInset',
                webPreferences: {
                    preload: join(this.options.currentDirectory, '../preload/process-explorer.cjs'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            },
            events: logEventCatalog.processExplorer,
            logger: this.options.logger,
            rendererUrl: resolveProcessExplorerRendererUrl(this.options),
            showOnReady: this.options.windowMode === 'visible',
        });
        this.window = window;
        window.on('closed', () => {
            if (this.window === window) this.window = undefined;
        });
    }
}

import { join } from 'node:path';

import { BrowserWindow, ipcMain } from 'electron';

import type { StructuredLogger } from '../shared/node/logger';
import { logEventCatalog } from '../shared/node/logger';
import type { ProcessExplorerSnapshot } from '../shared/process-explorer';
import { processExplorerSnapshotSchema } from '../shared/process-explorer';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import type { RendererErrorKind } from '../shared/renderer-error';
import { isRendererErrorKind, RENDERER_ERROR_CHANNELS } from '../shared/renderer-error';
import type { ThemeTokens } from '../shared/types';
import { consoleErrorLogFields } from './console-error-fields';
import { decideCrashRecovery } from './crash-policy';
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
    private rendererCrashTimestampsMs: number[] = [];
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
        if (this.window && !this.window.isDestroyed()) {
            if (this.window.isMinimized()) this.window.restore();
            if (this.options.windowMode === 'visible') {
                this.window.show();
                this.window.focus();
            }
            return;
        }
        const rendererUrl = resolveProcessExplorerRendererUrl(this.options);
        const window = new BrowserWindow({
            width: 1_280,
            height: 760,
            minWidth: 720,
            minHeight: 420,
            title: 'Process Explorer — Caxri',
            backgroundColor: '#282a36',
            titleBarStyle: 'hiddenInset',
            show: false,
            webPreferences: {
                preload: join(this.options.currentDirectory, '../preload/process-explorer.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        this.rendererCrashTimestampsMs = [];
        this.window = window;
        window.once('ready-to-show', () => {
            if (this.options.windowMode === 'visible') window.show();
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
            if (details.level !== 'error') return;
            this.options.logger.write('error', logEventCatalog.processExplorer.consoleError, {
                fields: consoleErrorLogFields(details),
            });
        });
        window.webContents.on('preload-error', () => {
            this.options.logger.write('error', logEventCatalog.processExplorer.preloadError, {
                fields: { code: 'PRELOAD_ERROR' },
            });
        });
        window.webContents.on('render-process-gone', (_event, details) => {
            if (details.reason === 'clean-exit' || window.isDestroyed() || this.window !== window)
                return;
            const { decision, crashTimestampsMs } = decideCrashRecovery(
                this.rendererCrashTimestampsMs,
                Date.now(),
            );
            this.rendererCrashTimestampsMs = crashTimestampsMs;
            if (decision.action === 'reload') {
                this.options.logger.write(
                    'warn',
                    logEventCatalog.processExplorer.renderProcessGone,
                    {
                        fields: {
                            code: 'RENDER_PROCESS_GONE',
                            reason: details.reason,
                            crashCount: decision.crashCount,
                            delayMs: decision.delayMs ?? 0,
                        },
                    },
                );
                setTimeout(() => {
                    if (this.window === window && !window.isDestroyed())
                        // `render-process-gone` recovery reload is best-effort: a failed reload
                        // here re-triggers this same crash-recovery handler on the next crash
                        // event, so it is deliberately fire-and-forget rather than awaited.
                        // eslint-disable-next-line unicorn/prefer-await -- see comment above
                        window.loadURL(rendererUrl).catch(() => {});
                }, decision.delayMs);
                return;
            }
            this.options.logger.write(
                'error',
                logEventCatalog.processExplorer.renderProcessCrashLoop,
                {
                    fields: {
                        code: 'RENDER_PROCESS_CRASH_LOOP',
                        reason: details.reason,
                        crashCount: decision.crashCount,
                    },
                },
            );
            /**
             * Process Explorer is optional diagnostics, so stop only its failed window. Creating the next window resets
             * crash history and leaves the healthy workbench untouched.
             */
            window.destroy();
        });
        window.on('closed', () => {
            if (this.window === window) this.window = undefined;
        });
        // `open()` creates the window synchronously and returns before navigation settles;
        // load failures surface through the 'render-process-gone'/'preload-error' handlers
        // above, so this is deliberately fire-and-forget rather than awaited.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        window.loadURL(rendererUrl).catch(() => {});
    }
}

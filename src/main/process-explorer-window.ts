import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { CaxriError } from '../shared/ipc/errors';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import {
    processExplorerSnapshotSchema,
    type ProcessExplorerSnapshot,
} from '../shared/process-explorer';
import type { StructuredLogger } from '../shared/node/logger';
import type { ThemeTokens } from '../shared/types';
import { decideCrashRecovery } from './crash-policy';
import type { ProcessExplorerSampler } from './process-explorer';
import type { E2EWindowMode } from './window-mode';

interface ProcessExplorerWindowOptions {
    currentDirectory: string;
    /** E2E-only render-exception seam; Main never enables it in normal launches. */
    forceRenderError?: boolean;
    logger: StructuredLogger;
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
        ipcMain.handle(
            PROCESS_EXPLORER_CHANNELS.snapshot,
            async (event): Promise<ProcessExplorerSnapshot> => {
                this.assertSender(event);
                const startedAt = performance.now();
                const snapshot = processExplorerSnapshotSchema.parse(
                    await this.options.sampler.snapshot(),
                );
                this.options.logger.write('debug', 'process_explorer.sample', {
                    durationMs: performance.now() - startedAt,
                    fields: { processes: snapshot.processes.length },
                });
                return snapshot;
            },
        );
        ipcMain.handle(PROCESS_EXPLORER_CHANNELS.theme, (event) => {
            this.assertSender(event);
            return this.options.theme();
        });
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
        const rendererUrl = this.resolveRendererUrl();
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
             * A crashed WebContents may no longer report its current URL. Compare against the
             * immutable entry URL so recovery is allowed without widening navigation privileges.
             */
            if (url === rendererUrl) return;
            event.preventDefault();
        });
        window.webContents.on('console-message', (details) => {
            if (details.level !== 'error') return;
            this.options.logger.write('error', 'process_explorer.console', {
                fields: { message: details.message.slice(0, 4_096) },
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
                this.options.logger.write('warn', 'process_explorer.render_process_gone', {
                    fields: {
                        reason: details.reason,
                        crashCount: decision.crashCount,
                        delayMs: decision.delayMs ?? 0,
                    },
                });
                setTimeout(() => {
                    if (this.window === window && !window.isDestroyed())
                        void window.loadURL(rendererUrl);
                }, decision.delayMs);
                return;
            }
            this.options.logger.write('error', 'process_explorer.render_process_crash_loop', {
                fields: { reason: details.reason, crashCount: decision.crashCount },
            });
            /**
             * Process Explorer is optional diagnostics, so stop only its failed window. Creating
             * the next window resets crash history and leaves the healthy workbench untouched.
             */
            window.destroy();
        });
        window.on('closed', () => {
            if (this.window === window) this.window = undefined;
        });
        void window.loadURL(rendererUrl);
    }

    private resolveRendererUrl(): string {
        let rendererUrl: URL;
        if (this.options.rendererUrl) {
            const base = this.options.rendererUrl.endsWith('/')
                ? this.options.rendererUrl
                : `${this.options.rendererUrl}/`;
            rendererUrl = new URL('process-explorer.html', base);
        } else {
            rendererUrl = pathToFileURL(
                join(this.options.currentDirectory, '../renderer/process-explorer.html'),
            );
        }
        if (this.options.forceRenderError)
            rendererUrl.searchParams.set('caxri-test-render-error', '1');
        return rendererUrl.toString();
    }

    private assertSender(event: IpcMainInvokeEvent): void {
        if (!this.window || event.sender !== this.window.webContents) {
            throw new CaxriError('PATH_DENIED', 'Untrusted Process Explorer IPC sender');
        }
    }
}

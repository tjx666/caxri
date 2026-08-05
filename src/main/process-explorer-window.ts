import { join } from 'node:path';

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { CaxriError } from '../shared/ipc/errors';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import {
    processExplorerSnapshotSchema,
    type ProcessExplorerSnapshot,
} from '../shared/process-explorer';
import type { StructuredLogger } from '../shared/node/logger';
import type { ThemeTokens } from '../shared/types';
import type { ProcessExplorerSampler } from './process-explorer';

interface ProcessExplorerWindowOptions {
    currentDirectory: string;
    logger: StructuredLogger;
    rendererUrl?: string;
    sampler: ProcessExplorerSampler;
    theme: () => Promise<ThemeTokens>;
}

export class ProcessExplorerWindowController {
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
            this.window.show();
            this.window.focus();
            return;
        }
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
        this.window = window;
        window.once('ready-to-show', () => window.show());
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.webContents.on('console-message', (details) => {
            if (details.level !== 'error') return;
            this.options.logger.write('error', 'process_explorer.console', {
                fields: { message: details.message.slice(0, 4_096) },
            });
        });
        window.on('closed', () => {
            if (this.window === window) this.window = undefined;
        });
        if (this.options.rendererUrl) {
            const base = this.options.rendererUrl.endsWith('/')
                ? this.options.rendererUrl
                : `${this.options.rendererUrl}/`;
            void window.loadURL(new URL('process-explorer.html', base).toString());
        } else {
            void window.loadFile(
                join(this.options.currentDirectory, '../renderer/process-explorer.html'),
            );
        }
    }

    private assertSender(event: IpcMainInvokeEvent): void {
        if (!this.window || event.sender !== this.window.webContents) {
            throw new CaxriError('PATH_DENIED', 'Untrusted Process Explorer IPC sender');
        }
    }
}

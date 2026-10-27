import { join } from 'node:path';

import type {
    AppLocale,
    AuxiliaryWindowState,
    RendererErrorKind,
    ThemeTokens,
} from '@caxri/protocol';
import { identifierSchema, isRendererErrorKind, RENDERER_ERROR_CHANNELS } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { ipcMain, screen } from 'electron';

import type { ProcessExplorerSnapshot } from '../shared/process-explorer';
import { processExplorerSnapshotSchema } from '../shared/process-explorer';
import { PROCESS_EXPLORER_CHANNELS } from '../shared/process-explorer-channels';
import {
    createAuxiliaryWindow,
    isAuxiliaryWindowRevealed,
    trackAuxiliaryWindowBounds,
} from './auxiliary-window';
import { AuxiliaryWindowBoundsMemory } from './auxiliary-window-bounds';
import { mainLocale } from './locale';
import type { ProcessExplorerSampler } from './process-explorer';
import {
    assertTrustedProcessExplorerSender,
    resolveProcessExplorerRendererUrl,
} from './process-explorer-window-helpers';
import { trafficLightPositionForZoom, zoomFactorForLevel } from './window-chrome';
import type { E2EWindowMode } from './window-mode';

interface ProcessExplorerWindowOptions {
    currentDirectory: string;
    /**
     * E2E-only render-exception seam; Main never enables it in normal launches.
     */
    forceRenderError?: boolean;
    logger: StructuredLogger;
    isPackaged: boolean;
    /**
     * Reads the `workbench.language` setting; `null` follows the system language.
     */
    language: () => Promise<AppLocale | null>;
    /**
     * Reads bounds persisted at the previous quit; see `CaxriBotWindowOptions.loadWindowState`.
     */
    loadWindowState: () => Promise<AuxiliaryWindowState['processExplorer']>;
    rendererUrl?: string;
    /**
     * Persists bounds; called once, from quit.
     */
    saveWindowState: (state: AuxiliaryWindowState['processExplorer']) => Promise<unknown>;
    sampler: ProcessExplorerSampler;
    /**
     * Suspends one running Terminal through Server Core; see `terminal.suspend`.
     */
    stopTerminal: (terminalId: string) => Promise<{ suspended: boolean }>;
    theme: () => Promise<ThemeTokens>;
    windowMode: E2EWindowMode;
    /**
     * The app-wide `window.zoomLevel` Main last applied, which a newly opened window starts at; see
     * `CaxriBotWindowOptions.zoomLevel`.
     */
    zoomLevel: () => number;
}

export class ProcessExplorerWindowController {
    private window?: BrowserWindow;
    /**
     * Where the last window stood, in memory for this run and seeded from the previous quit's persisted state by
     * `loadPersistedState()`; see the identical field on `CaxriBotWindowController`.
     */
    private readonly boundsMemory = new AuxiliaryWindowBoundsMemory(
        { width: 1_280, height: 760 },
        (rectangle) => screen.getDisplayMatching(rectangle),
    );

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
        ipcMain.handle(
            PROCESS_EXPLORER_CHANNELS.stopTerminal,
            (event, terminalId: unknown): Promise<{ suspended: boolean }> => {
                assertTrustedProcessExplorerSender(this.window?.webContents, event.sender);
                return this.options.stopTerminal(identifierSchema.parse(terminalId));
            },
        );
        ipcMain.handle(PROCESS_EXPLORER_CHANNELS.theme, (event) => {
            assertTrustedProcessExplorerSender(this.window?.webContents, event.sender);
            return this.options.theme();
        });
        ipcMain.handle(PROCESS_EXPLORER_CHANNELS.language, (event) => {
            assertTrustedProcessExplorerSender(this.window?.webContents, event.sender);
            return this.options.language();
        });
    }

    /**
     * Sends the open window the current `workbench.language` setting. Called on every `settings.changed`, which names
     * no key, so the window may receive an unchanged value; applying it again is a no-op there.
     */
    async refreshLanguage(): Promise<void> {
        const window = this.openWindow();
        if (!window) return;
        let preference: AppLocale | null;
        try {
            preference = await this.options.language();
        } catch {
            // The window keeps its current language; the next settings change tries again.
            return;
        }
        if (!window.isDestroyed())
            window.webContents.send(PROCESS_EXPLORER_CHANNELS.languageChanged, preference);
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

    /**
     * The window while it is open, which also follows the app-wide window zoom; see
     * `CaxriBotWindowController.openWindow`.
     */
    openWindow(): BrowserWindow | undefined {
        return this.window?.isDestroyed() ? undefined : this.window;
    }

    /**
     * Loads bounds persisted at the previous quit; see `CaxriBotWindowController.loadPersistedState`. Unlike the Caxri
     * Bot, Process Explorer never reopens itself at startup, so there is no boolean to return.
     */
    async loadPersistedState(): Promise<void> {
        try {
            const state = await this.options.loadWindowState();
            if (state.bounds) this.boundsMemory.remember(state.bounds);
        } catch {
            // Keep the window's built-in default bounds.
        }
    }

    /**
     * The window's current (or last remembered) bounds, computed synchronously so Caxri Bot's own
     * `persistWindowState()` can fold this half into the same combined `app.auxiliaryWindowState` row; see
     * `CaxriBotWindowController.currentWindowState` and `on-demand-windows.ts`.
     */
    currentWindowState(): AuxiliaryWindowState['processExplorer'] {
        const bounds =
            this.window && !this.window.isDestroyed()
                ? this.window.getNormalBounds()
                : this.boundsMemory.current();
        return { bounds };
    }

    /**
     * Persists the window's current (or last remembered) bounds; see `CaxriBotWindowController.persistWindowState`.
     */
    async persistWindowState(): Promise<void> {
        await this.options.saveWindowState(this.currentWindowState());
    }

    open(): void {
        if (isAuxiliaryWindowRevealed(this.window, this.options.windowMode === 'visible')) return;
        const zoomFactor = zoomFactorForLevel(this.options.zoomLevel());
        const window = createAuxiliaryWindow({
            browserWindow: {
                ...this.boundsMemory.boundsForOpen(),
                minWidth: 720,
                /**
                 * Matches `persistedWindowStateSchema.shape.bounds`'s own `height.min(480)`, which
                 * `auxiliaryWindowStateSchema` reuses for both windows: a smaller minimum here would let the user
                 * resize down to a height the combined `app.auxiliaryWindowState` row can never validate, silently
                 * failing to persist bounds for both this window and Caxri Bot.
                 */
                minHeight: 480,
                title: 'Process Explorer — Caxri',
                backgroundColor: '#282a36',
                titleBarStyle: 'hiddenInset',
                /**
                 * Same reasoning as Caxri Bot's window: the header is the Workbench's zoomed 36px drag header, and the
                 * window opens at the app zoom instead of flashing at 100% first.
                 */
                trafficLightPosition: trafficLightPositionForZoom(zoomFactor),
                webPreferences: {
                    preload: join(this.options.currentDirectory, '../preload/process-explorer.cjs'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    zoomFactor,
                },
            },
            events: logEventCatalog.processExplorer,
            logger: this.options.logger,
            rendererUrl: resolveProcessExplorerRendererUrl({
                ...this.options,
                locale: mainLocale(),
            }),
            showOnReady: this.options.windowMode === 'visible',
        });
        this.window = window;
        trackAuxiliaryWindowBounds(window, (bounds) => this.boundsMemory.remember(bounds));
        window.on('closed', () => {
            if (this.window === window) this.window = undefined;
        });
    }
}

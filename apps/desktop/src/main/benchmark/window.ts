import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';
import { screen } from 'electron';

import {
    createAuxiliaryWindow,
    isAuxiliaryWindowRevealed,
    trackAuxiliaryWindowBounds,
} from '../auxiliary-window/auxiliary-window';
import { AuxiliaryWindowBoundsMemory } from '../auxiliary-window/bounds';
import { resolveRendererEntryUrl } from '../renderer-entry';
import {
    publishFullScreenState,
    trafficLightPositionForZoom,
    zoomFactorForLevel,
} from '../window-chrome';
import type { E2EWindowMode } from '../window-mode';
import type { CompanionRendererPolicy } from '../workbench-ipc';
import { admitBenchmarkWindowRequest, isBenchmarkWindowEvent } from './window-policy';

interface BenchmarkWindowOptions {
    currentDirectory: string;
    isPackaged: boolean;
    logger: () => StructuredLogger | undefined;
    rendererUrl?: string;
    sendEvent: (event: ServerEvent) => void;
    windowMode: E2EWindowMode;
    /**
     * The app-wide `window.zoomLevel` Main last applied, which a newly opened window starts at.
     */
    zoomLevel: () => number;
}

/**
 * Owns the Benchmark window: a second Renderer, like Caxri Bot's, that loads the Workbench preload, shares Main's
 * single Desktop connection, and is admitted only for the requests `window-policy.ts` allows. Runs belong to the
 * Server, so closing the window stops nothing. See `docs/benchmark.md`.
 */
export class BenchmarkWindowController {
    private window?: BrowserWindow;
    private isEventsReady = false;
    /**
     * Where the last window stood, so a reopen within the same app run puts it back instead of at the default size.
     * Recorded after every move and resize, and clamped to the attached displays on every open.
     */
    private readonly boundsMemory = new AuxiliaryWindowBoundsMemory(
        { width: 1_280, height: 860 },
        (rectangle) => screen.getDisplayMatching(rectangle),
    );

    constructor(private readonly options: BenchmarkWindowOptions) {}

    /**
     * Opens the window, or raises it when it is already open.
     */
    open(): void {
        if (isAuxiliaryWindowRevealed(this.window, this.options.windowMode === 'visible')) return;
        const logger = this.options.logger();
        if (!logger) return;
        const zoomFactor = zoomFactorForLevel(this.options.zoomLevel());
        const window = createAuxiliaryWindow({
            browserWindow: {
                ...this.boundsMemory.boundsForOpen(),
                minWidth: 880,
                minHeight: 520,
                title: 'Benchmark — Caxri',
                backgroundColor: '#282a36',
                titleBarStyle: 'hiddenInset',
                // The header is a 36px drag header like the Workbench's, and the window opens at the app zoom.
                trafficLightPosition: trafficLightPositionForZoom(zoomFactor),
                webPreferences: {
                    preload: join(this.options.currentDirectory, '../preload/index.cjs'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    zoomFactor,
                },
            },
            events: logEventCatalog.benchmarkWindow,
            logger,
            rendererUrl: resolveRendererEntryUrl({
                currentDirectory: this.options.currentDirectory,
                isPackaged: this.options.isPackaged,
                page: 'benchmark.html',
                rendererUrl: this.options.rendererUrl,
            }),
            showOnReady: this.options.windowMode === 'visible',
        });
        this.window = window;
        this.isEventsReady = false;
        // A reload starts a new preload generation that must re-announce readiness before events reach it again.
        window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) this.isEventsReady = false;
        });
        trackAuxiliaryWindowBounds(window, (bounds) => this.boundsMemory.remember(bounds));
        publishFullScreenState(window, 'benchmark', this.options.sendEvent);
        window.on('closed', () => {
            if (this.window !== window) return;
            this.window = undefined;
            this.isEventsReady = false;
        });
    }

    /**
     * The window while it is open, which also follows the app-wide window zoom.
     */
    openWindow(): BrowserWindow | undefined {
        return this.window?.isDestroyed() ? undefined : this.window;
    }

    renderer(): WebContents | undefined {
        return this.openWindow()?.webContents;
    }

    processId(): number | undefined {
        return this.renderer()?.getOSProcessId();
    }

    close(): void {
        this.openWindow()?.close();
    }

    /**
     * The Workbench IPC companion contract for this window.
     */
    companion(): CompanionRendererPolicy {
        return {
            rendererWindow: 'benchmark',
            renderer: () => this.renderer(),
            window: () => this.openWindow(),
            admit: (raw) =>
                admitBenchmarkWindowRequest(raw, (method) =>
                    this.options
                        .logger()
                        ?.write('warn', logEventCatalog.benchmarkWindow.requestDenied, {
                            fields: { code: 'FORBIDDEN', method },
                        }),
                ),
            onEventsReady: () => {
                this.isEventsReady = true;
            },
            onRendererError: (kind) =>
                this.options
                    .logger()
                    ?.write(
                        'error',
                        kind === 'page-exception'
                            ? logEventCatalog.benchmarkWindow.pageException
                            : logEventCatalog.benchmarkWindow.unhandledRejection,
                        {
                            fields: {
                                code:
                                    kind === 'page-exception'
                                        ? 'PAGE_EXCEPTION'
                                        : 'UNHANDLED_REJECTION',
                            },
                        },
                    ),
        };
    }

    /**
     * Sends one relay message to this window when it acts on it, once its Renderer has subscribed; earlier durable
     * messages are recovered by the preload's own journal cursor. The Workbench always receives the message too.
     */
    relay(message: unknown): void {
        const renderer = this.renderer();
        if (renderer && this.isEventsReady && isBenchmarkWindowEvent(message))
            renderer.send('caxri:event', message);
    }
}

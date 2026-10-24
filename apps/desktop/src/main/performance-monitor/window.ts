import { join } from 'node:path';

import type {
    AppLocale,
    PerformanceMonitorMetrics,
    RendererErrorKind,
    ThemeTokens,
} from '@caxri/protocol';
import { isRendererErrorKind, RENDERER_ERROR_CHANNELS } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';
import { ipcMain, screen } from 'electron';

import type {
    PerformanceMonitorControl,
    PerformanceMonitorState,
} from '../../shared/performance-monitor';
import { performanceFrameSnapshotSchema } from '../../shared/performance-monitor';
import { PERFORMANCE_MONITOR_CHANNELS } from '../../shared/performance-monitor-channels';
import {
    createAuxiliaryWindow,
    isAuxiliaryWindowRevealed,
    trackAuxiliaryWindowBounds,
} from '../auxiliary-window';
import { AuxiliaryWindowBoundsMemory } from '../auxiliary-window-bounds';
import { mainLocale } from '../locale';
import { assertTrustedProcessExplorerSender } from '../process-explorer-window-helpers';
import { resolveRendererEntryUrl } from '../renderer-entry';
import { trafficLightPositionForZoom, zoomFactorForLevel } from '../window-chrome';
import type { E2EWindowMode } from '../window-mode';
import { ReloadTimeline } from './reload-timeline';

/**
 * How often Main re-reads the monitored window's visibility and pushes state, which also notices a recreated window.
 */
const STATE_TICK_MS = 2_000;

interface PerformanceMonitorWindowOptions {
    currentDirectory: string;
    isPackaged: boolean;
    language: () => Promise<AppLocale | null>;
    logger: StructuredLogger;
    metrics: () => Promise<PerformanceMonitorMetrics>;
    rendererUrl?: string;
    theme: () => Promise<ThemeTokens>;
    /**
     * The Workbench window being measured: the primary window, which a reload keeps alive.
     */
    target: () => BrowserWindow | undefined;
    windowMode: E2EWindowMode;
    zoomLevel: () => number;
}

/**
 * Owns the detached Performance Monitor window. It measures nothing itself: the monitored Workbench's Renderer samples
 * its own frames and publishes them here, and Main relays them. Keeping the monitor in a separate window is what lets
 * the Workbench reload while the monitor stays up and times that reload from Main's side. No `webContents.debugger`
 * attach happens anywhere in this path, because an attached debugger changes the page's visibility behaviour and would
 * distort the very frame rate being read.
 */
export class PerformanceMonitorWindowController {
    private window?: BrowserWindow;
    private attached?: { detach: () => void; webContents: WebContents };
    private tick?: ReturnType<typeof setInterval>;
    private alwaysOnTop = true;
    private lastLoggedId = -1;
    private readonly timeline = new ReloadTimeline();
    private readonly boundsMemory = new AuxiliaryWindowBoundsMemory(
        { width: 360, height: 560 },
        (rectangle) => screen.getDisplayMatching(rectangle),
    );

    constructor(private readonly options: PerformanceMonitorWindowOptions) {}

    private rendererUrl(): string {
        const url = new URL(
            resolveRendererEntryUrl({
                currentDirectory: this.options.currentDirectory,
                isPackaged: this.options.isPackaged,
                page: 'performance-monitor.html',
                rendererUrl: this.options.rendererUrl,
            }),
        );
        url.searchParams.set('caxri-locale', mainLocale());
        return url.href;
    }

    private assertTrusted(sender: unknown): void {
        assertTrustedProcessExplorerSender(this.window?.webContents, sender);
    }

    private setAlwaysOnTop(isOnTop: boolean): void {
        this.alwaysOnTop = isOnTop;
        const window = this.openWindow();
        if (window) window.setAlwaysOnTop(isOnTop, 'floating');
        this.publishState();
    }

    /**
     * Closes this window and hands the monitor back to the Workbench as its in-window overlay.
     */
    private switchToOverlay(): void {
        const target = this.attached?.webContents;
        this.close();
        if (target && !target.isDestroyed()) this.sendControl(target, { type: 'show-overlay' });
    }

    private state(): PerformanceMonitorState {
        const target = this.options.target();
        let targetState: PerformanceMonitorState['target'] = 'missing';
        if (target && !target.isDestroyed()) {
            if (target.webContents.isLoading()) targetState = 'loading';
            else if (target.isMinimized() || !target.isVisible()) targetState = 'hidden';
            else targetState = 'visible';
        }
        return {
            target: targetState,
            alwaysOnTop: this.alwaysOnTop,
            reloads: [...this.timeline.list()],
        };
    }

    private publishState(): void {
        this.logFinishedReloads();
        this.sendToWindow(PERFORMANCE_MONITOR_CHANNELS.state, this.state());
    }

    private sendToWindow(channel: string, payload: unknown): void {
        const window = this.openWindow();
        if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
    }

    private sendControl(webContents: WebContents, control: PerformanceMonitorControl): void {
        if (!webContents.isDestroyed())
            webContents.send(PERFORMANCE_MONITOR_CHANNELS.control, control);
    }

    /**
     * Writes one structured record per finished or failed load, so a slow reload is explainable from `desktop.jsonl`
     * after the monitor window is gone.
     */
    private logFinishedReloads(): void {
        for (const entry of this.timeline.list()) {
            if (entry.outcome === 'loading' || entry.id <= this.lastLoggedId) continue;
            this.lastLoggedId = Math.max(this.lastLoggedId, entry.id);
            this.options.logger.write(
                entry.outcome === 'failed' ? 'warn' : 'info',
                logEventCatalog.performanceMonitor.reload,
                {
                    durationMs: entry.stages.firstFrame ?? entry.stages.didFinishLoad,
                    fields: {
                        kind: entry.kind,
                        outcome: entry.outcome,
                        failure: entry.failure ?? null,
                        domReadyMs: entry.stages.domReady ?? null,
                        didFinishLoadMs: entry.stages.didFinishLoad ?? null,
                        loaderRemovedMs: entry.stages.loaderRemoved ?? null,
                        firstFrameMs: entry.stages.firstFrame ?? null,
                    },
                },
            );
        }
    }

    /**
     * Attaches the load listeners to the monitored window's current WebContents, and re-attaches when that window was
     * recreated. A newly attached Renderer is told to start publishing.
     */
    private attachTarget(): void {
        const window = this.options.target();
        const webContents = window && !window.isDestroyed() ? window.webContents : undefined;
        if (this.attached?.webContents === webContents) return;
        this.detachTarget(true);
        if (!webContents) return;
        const onStart = (
            _event: unknown,
            _url: string,
            isInPlace: boolean,
            isMainFrame: boolean,
        ): void => {
            if (!isMainFrame || isInPlace) return;
            this.timeline.begin();
            this.publishState();
        };
        const onDomReady = (): void => {
            this.timeline.mark('domReady');
            this.publishState();
        };
        const onFinish = (): void => {
            this.timeline.mark('didFinishLoad');
            // The new Renderer may have missed the earlier `start`; it also asks via `isActive` when it boots.
            this.sendControl(webContents, { type: 'start' });
            this.publishState();
        };
        const onFailLoad = (
            _event: unknown,
            errorCode: number,
            _description: string,
            _url: string,
            isMainFrame: boolean,
        ): void => {
            // -3 is ERR_ABORTED: a navigation superseded by the next one, not a failure of this load.
            if (!isMainFrame || errorCode === -3) return;
            this.timeline.fail('did-fail-load');
            this.publishState();
        };
        const onGone = (): void => {
            this.timeline.fail('render-process-gone');
            this.publishState();
        };
        const onUnresponsive = (): void => {
            this.timeline.fail('unresponsive');
            this.publishState();
        };
        webContents.on('did-start-navigation', onStart);
        webContents.on('dom-ready', onDomReady);
        webContents.on('did-finish-load', onFinish);
        webContents.on('did-fail-load', onFailLoad);
        webContents.on('render-process-gone', onGone);
        webContents.on('unresponsive', onUnresponsive);
        this.attached = {
            webContents,
            detach: () => {
                if (webContents.isDestroyed()) return;
                webContents.off('did-start-navigation', onStart);
                webContents.off('dom-ready', onDomReady);
                webContents.off('did-finish-load', onFinish);
                webContents.off('did-fail-load', onFailLoad);
                webContents.off('render-process-gone', onGone);
                webContents.off('unresponsive', onUnresponsive);
            },
        };
        this.sendControl(webContents, { type: 'start' });
    }

    private detachTarget(shouldStopPublishing: boolean): void {
        const attached = this.attached;
        this.attached = undefined;
        if (!attached) return;
        attached.detach();
        if (shouldStopPublishing) this.sendControl(attached.webContents, { type: 'stop' });
    }

    installIpc(): void {
        ipcMain.on(RENDERER_ERROR_CHANNELS.performanceMonitor, (event, rawKind: unknown) => {
            if (!this.window || event.sender !== this.window.webContents) return;
            if (!isRendererErrorKind(rawKind)) return;
            const kind: RendererErrorKind = rawKind;
            this.options.logger.write(
                'error',
                kind === 'page-exception'
                    ? logEventCatalog.performanceMonitor.pageException
                    : logEventCatalog.performanceMonitor.unhandledRejection,
                {
                    fields: {
                        code: kind === 'page-exception' ? 'PAGE_EXCEPTION' : 'UNHANDLED_REJECTION',
                    },
                },
            );
        });
        ipcMain.on(PERFORMANCE_MONITOR_CHANNELS.publish, (event, raw: unknown) => {
            // Only the monitored Workbench may publish, and only while a monitor window is waiting for it.
            if (!this.window || event.sender !== this.attached?.webContents) return;
            const parsed = performanceFrameSnapshotSchema.safeParse(raw);
            if (!parsed.success) return;
            this.sendToWindow(PERFORMANCE_MONITOR_CHANNELS.snapshot, parsed.data);
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.isActive, (event) =>
            Boolean(this.window && event.sender === this.attached?.webContents),
        );
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.getState, (event) => {
            this.assertTrusted(event.sender);
            return this.state();
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.metrics, (event) => {
            this.assertTrusted(event.sender);
            return this.options.metrics();
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.reload, (event, ignoreCache: unknown) => {
            this.assertTrusted(event.sender);
            this.reload(ignoreCache === true);
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.switchToOverlay, (event) => {
            this.assertTrusted(event.sender);
            this.switchToOverlay();
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.setAlwaysOnTop, (event, value: unknown) => {
            this.assertTrusted(event.sender);
            this.setAlwaysOnTop(value === true);
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.theme, (event) => {
            this.assertTrusted(event.sender);
            return this.options.theme();
        });
        ipcMain.handle(PERFORMANCE_MONITOR_CHANNELS.language, (event) => {
            this.assertTrusted(event.sender);
            return this.options.language();
        });
    }

    /**
     * Sends the open window the current `workbench.language` setting; see `ProcessExplorerWindowController`.
     */
    async refreshLanguage(): Promise<void> {
        const window = this.openWindow();
        if (!window) return;
        let preference: AppLocale | null;
        try {
            preference = await this.options.language();
        } catch {
            return;
        }
        if (!window.isDestroyed())
            window.webContents.send(PERFORMANCE_MONITOR_CHANNELS.languageChanged, preference);
    }

    processId(): number | undefined {
        if (!this.window || this.window.isDestroyed()) return undefined;
        return this.window.webContents.getOSProcessId();
    }

    openWindow(): BrowserWindow | undefined {
        return this.window?.isDestroyed() ? undefined : this.window;
    }

    /**
     * Feeds the Workbench's own startup-frame diagnostic to the reload timeline; see
     * `ReloadTimeline.recordStartupFrame`.
     */
    recordStartupFrame(frame: {
        firstFrameMs: number;
        loaderRemovedMs: number;
        timeOriginEpochMs: number;
    }): void {
        if (!this.window) return;
        this.timeline.recordStartupFrame(frame);
        this.publishState();
    }

    /**
     * Process and GPU readings for the in-window overlay, which has no Main window of its own to ask.
     */
    readMetrics(): Promise<PerformanceMonitorMetrics> {
        return this.options.metrics();
    }

    toggle(): void {
        if (this.openWindow()) this.close();
        else this.open();
    }

    close(): void {
        this.openWindow()?.close();
    }

    /**
     * Reloads the monitored Workbench from Main, so the timeline's `t0` is Main's own clock rather than a Renderer's
     * that is about to be torn down.
     */
    reload(shouldIgnoreCache: boolean): void {
        const webContents = this.attached?.webContents;
        if (!webContents || webContents.isDestroyed()) return;
        this.timeline.announce(shouldIgnoreCache ? 'hard-reload' : 'reload');
        if (shouldIgnoreCache) webContents.reloadIgnoringCache();
        else webContents.reload();
    }

    open(): void {
        if (isAuxiliaryWindowRevealed(this.window, this.options.windowMode === 'visible')) return;
        const zoomFactor = zoomFactorForLevel(this.options.zoomLevel());
        const window = createAuxiliaryWindow({
            browserWindow: {
                ...this.boundsMemory.boundsForOpen(),
                minWidth: 300,
                minHeight: 380,
                title: 'Performance Monitor — Caxri',
                backgroundColor: '#282a36',
                titleBarStyle: 'hiddenInset',
                trafficLightPosition: trafficLightPositionForZoom(zoomFactor),
                alwaysOnTop: this.alwaysOnTop,
                webPreferences: {
                    preload: join(
                        this.options.currentDirectory,
                        '../preload/performance-monitor.cjs',
                    ),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    zoomFactor,
                },
            },
            events: logEventCatalog.performanceMonitor,
            logger: this.options.logger,
            rendererUrl: this.rendererUrl(),
            showOnReady: this.options.windowMode === 'visible',
        });
        if (this.alwaysOnTop) window.setAlwaysOnTop(true, 'floating');
        this.window = window;
        trackAuxiliaryWindowBounds(window, (bounds) => this.boundsMemory.remember(bounds));
        this.attachTarget();
        this.tick = setInterval(() => {
            this.attachTarget();
            this.publishState();
        }, STATE_TICK_MS);
        this.tick.unref();
        window.on('closed', () => {
            if (this.window !== window) return;
            this.window = undefined;
            if (this.tick) clearInterval(this.tick);
            this.tick = undefined;
            this.detachTarget(true);
        });
    }
}

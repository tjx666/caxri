import { join } from 'node:path';

import type { AuxiliaryWindowState, CaxriBotOpenTarget, ServerEvent } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { screen } from 'electron';

import {
    createAuxiliaryWindow,
    isAuxiliaryWindowRevealed,
    trackAuxiliaryWindowBounds,
} from './auxiliary-window';
import { AuxiliaryWindowBoundsMemory } from './auxiliary-window-bounds';
import { CaxriBotRendererPolicy } from './caxri-bot-policy';
import type { AppMenuOptions } from './menu';
import { resolveRendererEntryUrl } from './renderer-entry';
import {
    publishFullScreenState,
    trafficLightPositionForZoom,
    zoomFactorForLevel,
} from './window-chrome';
import type { E2EWindowMode } from './window-mode';
import type { CompanionRendererPolicy } from './workbench-ipc';

interface CaxriBotWindowOptions {
    currentDirectory: string;
    detachTerminal: (terminalId: string) => Promise<unknown>;
    isPackaged: boolean;
    /**
     * Reads bounds/open state persisted at the previous quit. Failure (e.g. Server not yet reachable) is handled by the
     * caller, matching every other Main-only Server prefetch.
     */
    loadWindowState: () => Promise<AuxiliaryWindowState['caxriBot']>;
    logger: () => StructuredLogger | undefined;
    rendererUrl?: string;
    /**
     * Persists bounds/open state; called once, from quit.
     */
    saveWindowState: (state: AuxiliaryWindowState['caxriBot']) => Promise<unknown>;
    /**
     * Publishes a Main-originated event through the same relay the Server's events take, so a reloading window recovers
     * it from the journal like any other durable event.
     */
    sendEvent: (event: ServerEvent) => void;
    stopBot: () => Promise<unknown>;
    windowMode: E2EWindowMode;
    /**
     * The app-wide `window.zoomLevel` Main last applied, which a newly opened window starts at.
     */
    zoomLevel: () => number;
}

/**
 * Owns Caxri Bot's window: a second Renderer that loads the Workbench preload, shares Main's single Desktop connection,
 * and is admitted only for the requests `CaxriBotRendererPolicy` allows. See `docs/caxri-bot.md`.
 */
export class CaxriBotWindowController {
    private window?: BrowserWindow;
    private isEventsReady = false;
    /**
     * A `caxriBot.open` asked for the Inbox and the window has not been told yet: a window the request itself opened
     * cannot receive the event until its Renderer subscribes, so the request waits for `onEventsReady`.
     *
     * `open()` is the only writer besides delivery: it overwrites the flag on every call, and a window can only appear
     * through `open()`. So a request whose window closed, or never opened because no logger was available, can never
     * reach a later window, and neither case needs its own reset.
     */
    private isInboxRequested = false;
    /**
     * Where the last window stood. Caxri Bot outlives its window and the user reopens it often, so a reopen puts it
     * back instead of at the default size in the middle of the screen. Recorded after every move and resize as well as
     * on close, because a crash loop destroys the window without a `close` event. Seeded from the previous quit's
     * persisted state by `loadPersistedState()`, so it also survives an app restart, and clamped to the attached
     * displays on every open.
     */
    private readonly boundsMemory = new AuxiliaryWindowBoundsMemory(
        { width: 1_320, height: 820 },
        (rectangle) => screen.getDisplayMatching(rectangle),
    );
    readonly policy: CaxriBotRendererPolicy;

    constructor(private readonly options: CaxriBotWindowOptions) {
        this.policy = new CaxriBotRendererPolicy((method) =>
            this.options.logger()?.write('warn', logEventCatalog.caxriBot.requestDenied, {
                fields: { code: 'FORBIDDEN', method },
            }),
        );
    }

    /**
     * A closing or reloading window never runs its React unmount, so Main releases the Server-side view attachment
     * itself; Caxri Bot's PTY keeps running and the next window re-attaches with a snapshot. A close cannot await
     * Server I/O, and a failed detach only leaves a view the next attach replaces, so it is fire-and-forget.
     */
    private releaseTerminal(isClosed: boolean): void {
        const terminalId = this.policy.viewedTerminalId();
        if (isClosed) this.policy.reset();
        else this.policy.releaseView();
        // eslint-disable-next-line unicorn/prefer-await -- see JSDoc above
        if (terminalId) this.options.detachTerminal(terminalId).catch(() => {});
    }

    /**
     * Sends a pending Inbox request straight to this window, which is its only audience: the Workbench has no Inbox
     * column, so the request never enters the shared relay.
     */
    private deliverInboxRequest(): void {
        if (!this.isInboxRequested || !this.isEventsReady) return;
        const renderer = this.renderer();
        if (!renderer) return;
        this.isInboxRequested = false;
        const event: ServerEvent = { event: 'caxriBot.inboxRequested', payload: {} };
        renderer.send('caxri:event', event);
    }

    private openWindowIfClosed(): void {
        if (isAuxiliaryWindowRevealed(this.window, this.options.windowMode === 'visible')) return;
        const logger = this.options.logger();
        if (!logger) return;
        const zoomFactor = zoomFactorForLevel(this.options.zoomLevel());
        const window = createAuxiliaryWindow({
            browserWindow: {
                ...this.boundsMemory.boundsForOpen(),
                minWidth: 760,
                minHeight: 480,
                title: 'Caxri Bot — Caxri',
                backgroundColor: '#282a36',
                titleBarStyle: 'hiddenInset',
                /**
                 * The header is the Workbench's 36px drag header, so the traffic lights sit where they do there, and
                 * the window opens at the app zoom instead of flashing at 100% first.
                 */
                trafficLightPosition: trafficLightPositionForZoom(zoomFactor),
                webPreferences: {
                    preload: join(this.options.currentDirectory, '../preload/index.cjs'),
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                    zoomFactor,
                },
            },
            events: logEventCatalog.caxriBot,
            logger,
            rendererUrl: resolveRendererEntryUrl({
                currentDirectory: this.options.currentDirectory,
                isPackaged: this.options.isPackaged,
                page: 'caxri-bot.html',
                rendererUrl: this.options.rendererUrl,
            }),
            showOnReady: this.options.windowMode === 'visible',
        });
        this.window = window;
        this.isEventsReady = false;
        /**
         * A reload (crash recovery) starts a new preload generation that must re-announce readiness and re-learn its
         * Terminal through `bot.ensure` before any PTY bytes are routed to it again.
         */
        window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
            if (!isMainFrame || isInPlace) return;
            this.isEventsReady = false;
            this.releaseTerminal(false);
        });
        trackAuxiliaryWindowBounds(window, (bounds) => this.boundsMemory.remember(bounds));
        publishFullScreenState(window, 'caxriBot', this.options.sendEvent);
        window.on('closed', () => {
            if (this.window !== window) return;
            this.window = undefined;
            this.isEventsReady = false;
            this.releaseTerminal(true);
        });
    }

    /**
     * The window while it is open, which also follows the app-wide window zoom.
     */
    openWindow(): BrowserWindow | undefined {
        return this.window?.isDestroyed() ? undefined : this.window;
    }

    /**
     * The Workbench IPC companion contract for this window.
     */
    companion(): CompanionRendererPolicy {
        return {
            rendererWindow: 'bot',
            renderer: () => this.renderer(),
            window: () => this.openWindow(),
            admit: (raw) => this.policy.admit(raw),
            observeReply: (raw, reply) => this.policy.observeReply(raw, reply),
            onEventsReady: () => {
                this.isEventsReady = true;
                this.deliverInboxRequest();
            },
            onRendererError: (kind) =>
                this.options
                    .logger()
                    ?.write(
                        'error',
                        kind === 'page-exception'
                            ? logEventCatalog.caxriBot.pageException
                            : logEventCatalog.caxriBot.unhandledRejection,
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
     * Sends one relay message to this window when `CaxriBotRendererPolicy.route` assigns it here, once the window has
     * subscribed; earlier messages are recovered by the preload's own journal cursor. Returns whether the Workbench
     * should receive the message too.
     */
    relay(message: unknown): boolean {
        const route = this.policy.route(message);
        const renderer = this.renderer();
        if (renderer && route.bot && this.isEventsReady) renderer.send('caxri:event', message);
        return route.workbench;
    }

    renderer(): WebContents | undefined {
        if (!this.window || this.window.isDestroyed()) return undefined;
        return this.window.webContents;
    }

    processId(): number | undefined {
        return this.renderer()?.getOSProcessId();
    }

    close(): void {
        if (this.window && !this.window.isDestroyed()) this.window.close();
    }

    /**
     * Loads bounds/open state persisted at the previous quit and returns whether Caxri Bot was open then: the
     * cold-start signal `index.ts` uses to decide whether to reopen it once the Workbench is ready. The bounds are
     * clamped to the attached displays when the window opens, not here. A failed read (Server unreachable, corrupted
     * state) keeps the window's built-in default bounds and answers `false`, so a boot-time hiccup never blocks startup
     * on reopening an optional window.
     */
    async loadPersistedState(): Promise<boolean> {
        try {
            const state = await this.options.loadWindowState();
            if (state.bounds) this.boundsMemory.remember(state.bounds);
            return state.wasOpenAtQuit;
        } catch {
            return false;
        }
    }

    /**
     * The window's current (or last remembered) bounds and whether it is open right now, computed synchronously so the
     * Process Explorer's own `persistWindowState()` can fold this half into the same combined
     * `app.auxiliaryWindowState` row without an extra Server round trip; see `on-demand-windows.ts`.
     */
    currentWindowState(): AuxiliaryWindowState['caxriBot'] {
        const bounds =
            this.window && !this.window.isDestroyed()
                ? this.window.getNormalBounds()
                : this.boundsMemory.current();
        return { bounds, wasOpenAtQuit: this.openWindow() !== undefined };
    }

    /**
     * Persists the window's current (or last remembered) bounds and whether it is open right now. Called once, from
     * quit, alongside the main window's own realtime-persisted bounds: an optional window the user may never reopen
     * does not need a debounced write on every drag, only a value available at the next launch.
     */
    async persistWindowState(): Promise<void> {
        await this.options.saveWindowState(this.currentWindowState());
    }

    /**
     * Closes the window first so it never shows its own Terminal going away, then stops Caxri Bot on the Server.
     * Reopening the window runs `bot.ensure`, which resumes the same Agent conversation.
     */
    async stop(): Promise<void> {
        this.close();
        try {
            await this.options.stopBot();
        } catch (error) {
            this.options.logger()?.write('error', logEventCatalog.caxriBot.stopFailed, {
                fields: { code: isCaxriError(error) ? error.code : 'INTERNAL' },
            });
            throw error;
        }
    }

    /**
     * Opens this window's own Command Palette when `window` is this window, and returns whether it was. The request
     * goes straight to this Renderer like the Inbox request does: the Workbench has a palette of its own. A window
     * still loading swallows it, since the shortcut was typed there and the Workbench is not what the user is looking
     * at.
     */
    requestCommandPalette(window: BaseWindow): boolean {
        if (window !== this.openWindow()) return false;
        const renderer = this.renderer();
        if (!renderer || !this.isEventsReady) return true;
        const event: ServerEvent = { event: 'caxriBot.commandPaletteRequested', payload: {} };
        renderer.send('caxri:event', event);
        return true;
    }

    /**
     * Opens or raises the window. `target: 'inbox'` also asks its Renderer to open the Inbox and focus the first open
     * item, delivered as soon as the window listens for events.
     */
    open(target?: CaxriBotOpenTarget): void {
        this.isInboxRequested = target === 'inbox';
        this.openWindowIfClosed();
        this.deliverInboxRequest();
    }
}

/**
 * Caxri Bot's part of the app menu's routing: Open Caxri Bot, and its own Command Palette taking `Cmd+Shift+P` while it
 * is focused. The controller is read per click, since it is created after the menu is first built.
 */
export function caxriBotMenuOptions(
    controller: () => CaxriBotWindowController | undefined,
): Pick<AppMenuOptions, 'openCaxriBot' | 'openWindowCommandPalette'> {
    return {
        openCaxriBot: () => controller()?.open(),
        openWindowCommandPalette: (window) => controller()?.requestCommandPalette(window) ?? false,
    };
}

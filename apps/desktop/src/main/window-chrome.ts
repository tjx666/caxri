import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import type { BrowserWindow, BrowserWindowConstructorOptions, Point } from 'electron';

/**
 * Height of the Renderer's drag header (`h-9`) in CSS pixels, and the traffic-light inset that centers the 14px-tall
 * macOS window buttons inside it at 100% zoom.
 */
const HEADER_HEIGHT_CSS_PX = 36;
const TRAFFIC_LIGHT_HEIGHT_PX = 14;
const TRAFFIC_LIGHT_X_PX = 15;

/**
 * `window.zoomLevel` uses Chromium's own scale (each step is 20%), which is also VS Code's `window.zoomLevel`, so a
 * value copied between the two means the same size.
 *
 * @see https://www.electronjs.org/docs/latest/api/web-contents#contentssetzoomlevellevel
 */
export function zoomFactorForLevel(level: number): number {
    return 1.2 ** level;
}

/**
 * Page zoom scales the Renderer's header but not the native traffic lights, so their inset is recomputed to stay
 * vertically centered in the zoomed header. The horizontal inset stays fixed; the Renderer divides its own clearance by
 * the zoom factor to keep it that same physical width.
 */
export function trafficLightPositionForZoom(zoomFactor: number): Point {
    return {
        x: TRAFFIC_LIGHT_X_PX,
        y: Math.round((HEADER_HEIGHT_CSS_PX * zoomFactor - TRAFFIC_LIGHT_HEIGHT_PX) / 2),
    };
}

export function applyWindowZoom(window: BrowserWindow, level: number): void {
    if (window.isDestroyed()) return;
    window.webContents.setZoomLevel(level);
    if (process.platform === 'darwin')
        window.setWindowButtonPosition(trafficLightPositionForZoom(zoomFactorForLevel(level)));
}

/**
 * The main window's frame and backdrop at a given page zoom factor.
 */
export function mainWindowChromeOptions(
    zoomFactor: number,
    platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions {
    return {
        /**
         * On macOS the window starts as a translucent `vibrancy` material behind a transparent page, so the inline
         * startup loader in `renderer/index.html` floats the Caxri mark over the blurred desktop before any bundle has
         * run; the mounted workbench then paints its own opaque theme background over the material. The material
         * follows the system appearance (Electron has no per-window dark override short of `nativeTheme.themeSource`,
         * which would also flip menus and dialogs), so in a light appearance it is a white sheet: the loader paints
         * this same `#282a36` over it under `prefers-color-scheme: light` and the launch never shows white. Other
         * platforms keep the deliberate color literal, which mirrors the default theme's `--background` and prevents a
         * white flash on launch; an imported theme cannot change it.
         */
        ...(platform === 'darwin'
            ? { backgroundColor: '#00000000', vibrancy: 'under-window' as const }
            : { backgroundColor: '#282a36' }),
        /**
         * No title bar row: the primarySidebar header is the drag region and carries the brand instead. `title` stays
         * for VoiceOver and Mission Control, which still read the window title.
         */
        titleBarStyle: 'hiddenInset',
        /**
         * Centers the macOS traffic lights in the Renderer's 36px drag header, scaled by the page zoom.
         */
        trafficLightPosition: trafficLightPositionForZoom(zoomFactor),
    };
}

export interface WindowZoomController {
    /**
     * Reads the persisted level for a window about to be created and remembers it as applied.
     */
    load(): Promise<number>;
    /**
     * The level last loaded or applied, for a window created after startup.
     */
    level(): number;
    /**
     * Re-reads the level after a settings write and applies it only when it changed.
     */
    refresh(): void;
}

/**
 * `settings.changed` names no key, so the controller compares each reload against the last applied level and leaves the
 * windows alone for every unrelated settings write. A failed read keeps the current level. `window.zoomLevel` is one
 * app-wide setting, so every window that shares the Workbench's 36px drag header follows it: the Workbench and the
 * Agent Commander.
 */
export function createWindowZoomController(options: {
    loadLevel: () => Promise<number>;
    windows: () => ReadonlyArray<BrowserWindow | undefined>;
}): WindowZoomController {
    let applied = 0;
    const read = async (): Promise<number> => {
        try {
            return await options.loadLevel();
        } catch {
            return applied;
        }
    };
    return {
        async load() {
            applied = await read();
            return applied;
        },
        level: () => applied,
        refresh() {
            // A synchronous event listener; `read` already falls back on failure, so this is deliberately
            // fire-and-forget rather than awaited.
            // eslint-disable-next-line no-void -- see comment above
            void read().then((level) => {
                if (level === applied) return;
                applied = level;
                for (const window of options.windows()) if (window) applyWindowZoom(window, level);
            });
        },
    };
}

/**
 * Publishes one window's macOS fullscreen state as `window.fullScreen`; fullscreen hides the traffic lights, so the
 * Renderer drops their clearance and shows the logo instead. Durable delivery reaches every Renderer, hence `kind`.
 * These pushes only report transitions: a Renderer that loads (or reloads) while its window is already fullscreen reads
 * the current state through `window.fullScreen.get`, because a fresh Renderer whose recovery falls back to a snapshot
 * never replays an earlier push.
 */
export function publishFullScreenState(
    window: BrowserWindow,
    kind: 'workbench' | 'agentCommander' | 'benchmark',
    sendEvent: (event: ServerEvent, windowKey?: string) => void,
    windowKey?: string,
): void {
    const send = (): void =>
        sendEvent(
            {
                event: 'window.fullScreen',
                payload: { window: kind, isFullScreen: window.isFullScreen() },
            },
            windowKey,
        );
    window.on('enter-full-screen', send);
    window.on('leave-full-screen', send);
}

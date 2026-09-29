import type { PersistedWindowState } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';

import { applyWindowZoom } from './window-chrome';

/**
 * Where the Workbench window belongs: its saved geometry and the app-wide `window.zoomLevel`. Both live in Server Core,
 * so they arrive after the window already exists.
 */
export interface WindowPlacement {
    state: PersistedWindowState;
    zoomLevel: number;
}

/**
 * Geometry for a window whose saved state cannot be read, and the size a window is constructed at before its placement
 * arrives.
 */
export const defaultWindowState: PersistedWindowState = {
    bounds: { width: 1440, height: 900 },
    isMaximized: false,
    isFullScreen: false,
};

/**
 * Upper bound on waiting for the re-zoomed page to present before showing; a hidden window may never deliver the frame.
 */
const ZOOM_PRESENT_TIMEOUT_MS = 200;

async function waitForZoomedFrame(window: BrowserWindow): Promise<void> {
    await Promise.race([
        window.webContents.executeJavaScript(
            'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
        ),
        new Promise((resolve) => {
            setTimeout(resolve, ZOOM_PRESENT_TIMEOUT_MS);
        }),
    ]);
}

/**
 * Applies a placement to a still-hidden window. Maximize and fullscreen restore last, after the normal bounds they
 * return to. A non-default zoom waits for the re-laid-out page to present, so showing never flashes the loader at
 * 100%.
 */
async function applyWindowPlacement(
    window: BrowserWindow,
    { state, zoomLevel }: WindowPlacement,
): Promise<void> {
    if (window.isDestroyed()) return;
    const { x, y, width, height } = state.bounds;
    if (x === undefined || y === undefined) {
        window.setSize(width, height);
        window.center();
    } else window.setBounds({ x, y, width, height });
    if (zoomLevel !== 0) {
        applyWindowZoom(window, zoomLevel);
        try {
            await waitForZoomedFrame(window);
        } catch {
            // A page that cannot run the probe is shown without waiting for its re-zoomed frame.
        }
    }
    if (window.isDestroyed()) return;
    if (state.isMaximized) window.maximize();
    if (state.isFullScreen) window.setFullScreen(true);
}

/**
 * Shows the window once it has painted its startup loader (`ready-to-show`) and its placement has been applied,
 * whichever comes last. Creating the window before Server Core attaches is what lets the Renderer load in parallel with
 * Server Core startup; holding `show` until the placement lands keeps the window from appearing at the default size and
 * jumping.
 */
export function showWhenPlaced(
    window: BrowserWindow,
    placement: Promise<WindowPlacement>,
    show: () => void,
): void {
    const readyToShow = new Promise<void>((resolve) => {
        window.once('ready-to-show', () => resolve());
    });
    const place = async (): Promise<void> => applyWindowPlacement(window, await placement);
    const showWhenReady = async (): Promise<void> => {
        await Promise.all([readyToShow, place()]);
        if (!window.isDestroyed()) show();
    };
    // Called from the synchronous window constructor path. A placement that never arrives (the launch is quitting)
    // leaves the window hidden, which is the intended outcome.
    // eslint-disable-next-line unicorn/prefer-await -- see comment above
    showWhenReady().catch(() => {});
}

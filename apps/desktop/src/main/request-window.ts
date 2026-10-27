import { AsyncLocalStorage } from 'node:async_hooks';

import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';

/**
 * The window whose Renderer sent the request Main is handling. The command dispatcher is transport-neutral and its
 * execution context carries no Electron objects, so a Main method that presents native UI over its caller (the Agent
 * Caxri Bot's Terminal's context menu) reads the caller here instead of assuming the Workbench window. Requests that
 * run outside `runInRequestWindow`, including every Workbench request, fall back to the Workbench window.
 */
const requestWindow = new AsyncLocalStorage<BrowserWindow>();

export function runInRequestWindow<T>(window: BrowserWindow | undefined, run: () => T): T {
    return window ? requestWindow.run(window, run) : run();
}

export function currentRequestWindow(): BrowserWindow | undefined {
    const window = requestWindow.getStore();
    return window && !window.isDestroyed() ? window : undefined;
}

/**
 * The window native UI for the current request attaches to: the requesting window, else `fallback` (the Workbench).
 * Throws `UNAVAILABLE` when neither is open, so a sheet never opens detached.
 */
export function requestWindowOr(fallback: BrowserWindow | undefined): BrowserWindow {
    const window = currentRequestWindow() ?? fallback;
    if (!window || window.isDestroyed())
        throw new CaxriError('UNAVAILABLE', 'No window is available for this request');
    return window;
}

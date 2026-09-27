import { AsyncLocalStorage } from 'node:async_hooks';

import type { BrowserWindow } from 'electron';

/**
 * The window whose Renderer sent the request Main is handling. The command dispatcher is transport-neutral and its
 * execution context carries no Electron objects, so a Main method that presents native UI over its caller — the Agent
 * Commander Terminal's context menu — reads the caller here instead of assuming the Workbench window. Requests that run
 * outside `runInRequestWindow`, including every Workbench request, fall back to the Workbench window.
 */
const requestWindow = new AsyncLocalStorage<BrowserWindow>();

export function runInRequestWindow<T>(window: BrowserWindow | undefined, run: () => T): T {
    return window ? requestWindow.run(window, run) : run();
}

export function currentRequestWindow(): BrowserWindow | undefined {
    const window = requestWindow.getStore();
    return window && !window.isDestroyed() ? window : undefined;
}

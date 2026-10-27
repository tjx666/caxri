import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface RendererEntryOptions {
    currentDirectory: string;
    isPackaged: boolean;
    page:
        | 'caxri-bot.html'
        | 'benchmark.html'
        | 'index.html'
        | 'performance-monitor.html'
        | 'process-explorer.html';
    rendererUrl?: string;
}

interface RendererEntryWindow {
    loadURL(url: string): unknown;
}

/**
 * Resolves renderer entry points from trusted application files in packaged builds. Development's
 * `ELECTRON_RENDERER_URL` is injected by electron-vite, but an inherited environment must never redirect a packaged
 * Workbench or diagnostic window to that untrusted development origin.
 */
export function resolveRendererEntryUrl({
    currentDirectory,
    isPackaged,
    page,
    rendererUrl,
}: RendererEntryOptions): string {
    if (!isPackaged && rendererUrl) {
        if (page === 'index.html') return rendererUrl;
        const base = rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`;
        return new URL(page, base).href;
    }
    return pathToFileURL(join(currentDirectory, '../renderer', page)).toString();
}

/**
 * Loads a renderer entry through the same packaged-origin guard used by every window.
 */
export function loadRendererEntry(
    window: RendererEntryWindow,
    options: RendererEntryOptions,
): string {
    const rendererEntryUrl = resolveRendererEntryUrl(options);
    window.loadURL(rendererEntryUrl);
    return rendererEntryUrl;
}

import type { E2EApp } from './electron-app.ts';

/**
 * Drives the same Main-to-Renderer event that native macOS fullscreen transitions publish. Chrome assertions do not
 * need to move the test runner into a native Space, which is unavailable when a local CI fallback runs with the console
 * locked.
 */
export async function publishFullScreenState(app: E2EApp, isFullScreen: boolean): Promise<void> {
    await app.evaluate(({ BrowserWindow }, nextFullScreen) => {
        // `.at()` (not index access, which types the element as always-defined) types `window` as
        // possibly `undefined`, matching the real possibility of no open window.
        const window = BrowserWindow.getAllWindows().at(0);
        if (!window) throw new Error('Caxri window is unavailable');
        window.webContents.send('caxri:event', {
            event: 'window.fullScreen',
            payload: { window: 'workbench', isFullScreen: nextFullScreen },
        });
    }, isFullScreen);
}

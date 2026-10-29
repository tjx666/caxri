import { caxri } from '../../lib/caxri';

/**
 * Asks Main to put this window in or out of native full screen. Resolves `false` when Main refuses, so Zen Mode keeps
 * working in a window instead of surfacing an error for a nicety.
 */
export async function didRequestWindowFullScreen(isFullScreen: boolean): Promise<boolean> {
    try {
        await caxri.request('window.fullScreen.set', { isFullScreen });
        return true;
    } catch {
        // Main records the failed request.
        return false;
    }
}

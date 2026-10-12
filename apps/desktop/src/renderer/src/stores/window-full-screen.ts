import { caxri } from '../lib/caxri';
import { useWorkbenchStore } from './workbench';

/**
 * Reads this window's current fullscreen state after its event subscription starts. `window.fullScreen` pushes only
 * report transitions, and a Renderer that (re)loads while already fullscreen cannot count on replaying the last one:
 * once the event journal has rotated, its recovery is a snapshot that carries no window state. A transition that lands
 * while this read is in flight still arrives as a live event, after the reply Main computed before it.
 */
export async function syncWindowFullScreen(): Promise<void> {
    try {
        const { isFullScreen } = await caxri.request('window.fullScreen.get');
        useWorkbenchStore.setState({ isFullScreen });
    } catch {
        // Main records the failed request; the chrome keeps its last known state until the next transition event.
    }
}

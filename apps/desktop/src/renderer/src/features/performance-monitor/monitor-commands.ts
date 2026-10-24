import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import { useMonitorStore } from './monitor-store';

async function requestWindow(action: 'close' | 'open' | 'toggle'): Promise<void> {
    await tryCommand(translate('performanceMonitor.openFailed'), () =>
        caxri.request('performanceMonitor.window', { action }),
    );
}

/**
 * The `developer.togglePerformanceMonitor` command: shows or hides the monitor in whichever form the user last chose.
 */
export function togglePerformanceMonitor(): void {
    const { closeOverlay, isOverlayOpen, mode, openOverlay } = useMonitorStore.getState();
    if (mode === 'window') {
        void requestWindow('toggle');
        return;
    }
    if (isOverlayOpen) closeOverlay();
    else openOverlay();
}

/**
 * Opens the monitor in its own window and remembers that choice; also what the overlay's mode switch does.
 */
export function openPerformanceMonitorWindow(): void {
    const { closeOverlay, setMode } = useMonitorStore.getState();
    setMode('window');
    closeOverlay();

    void requestWindow('open');
}

/**
 * Shows the in-window overlay and remembers that choice. Main calls this (through the host bridge) when the monitor
 * window's switch hands the monitor back.
 */
export function showPerformanceMonitorOverlay(): void {
    const { openOverlay, setMode } = useMonitorStore.getState();
    setMode('overlay');
    openOverlay();
}

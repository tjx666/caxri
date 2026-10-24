import { performanceCollector } from './collector';
import { showPerformanceMonitorOverlay } from './monitor-commands';

const PUBLISH_INTERVAL_MS = 250;

/**
 * Connects this Workbench to a detached Performance Monitor window. While Main says a monitor is open, it samples
 * frames through the shared collector and publishes a snapshot four times a second; Main relays it. The Renderer
 * measures itself, so no debugger is attached and the window's visibility behaves as a user sees it.
 *
 * A reload creates a new Renderer that missed the earlier `start`, so it also asks Main once at boot whether a monitor
 * is waiting.
 */
export function installPerformanceMonitorHostLink(): void {
    const host = globalThis.performanceMonitorHost;
    if (!host) return;
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
        if (timer !== undefined) return;
        release = performanceCollector.acquire();
        timer = setInterval(
            () => host.publish(performanceCollector.snapshot()),
            PUBLISH_INTERVAL_MS,
        );
    };
    const stop = (): void => {
        if (timer === undefined) return;
        clearInterval(timer);
        timer = undefined;
        release?.();
        release = undefined;
    };
    host.onControl((control) => {
        if (control.type === 'start') start();
        else if (control.type === 'stop') stop();
        else showPerformanceMonitorOverlay();
    });
    async function resumeIfActive(): Promise<void> {
        try {
            if (await host?.isActive()) start();
        } catch {
            // Main is still starting; its `start` control reaches this window once the load finishes.
        }
    }
    // eslint-disable-next-line no-void -- resumeIfActive() never rejects
    void resumeIfActive();
}

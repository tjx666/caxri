import type { ServerEvent } from '@caxri/protocol';

export interface BenchmarkWindowEventEffect {
    /**
     * Re-read the snapshot the window renders from: its Projects, Settings, and theme.
     */
    snapshot: boolean;
    /**
     * Re-read every Benchmark query: runs may have moved on while events could not arrive.
     */
    runs: boolean;
    isFullScreen?: boolean;
}

const NO_EFFECT: BenchmarkWindowEventEffect = { snapshot: false, runs: false };

/**
 * Maps one Server event onto the Benchmark window's refreshes. Deliberately partial, like Caxri Bot's: UI commands
 * belong to the Workbench window, and Session or Terminal record changes concern nothing this window shows. Run
 * progress arrives through `benchmark.changed`, which the page's own queries handle.
 */
export function benchmarkWindowEventEffect(event: ServerEvent): BenchmarkWindowEventEffect {
    switch (event.event) {
        case 'state.changed':
            // Projects are added, removed, and renamed through full snapshots; record changes name Sessions only.
            return event.payload.kind === 'full' ? { ...NO_EFFECT, snapshot: true } : NO_EFFECT;
        case 'runtime.status':
            return event.payload.status === 'ready' ? { snapshot: true, runs: true } : NO_EFFECT;
        case 'host.connectionChanged':
            // `replaced` means another window took over this profile; the Workbench window reports it.
            return event.payload.status === 'replaced' ? NO_EFFECT : { snapshot: true, runs: true };
        case 'settings.changed':
        case 'keybindings.changed':
        case 'theme.changed':
            // A configuration error is reported by the Workbench window, which owns Settings.
            return event.payload.error ? NO_EFFECT : { ...NO_EFFECT, snapshot: true };
        case 'window.fullScreen':
            return event.payload.window === 'benchmark'
                ? { ...NO_EFFECT, isFullScreen: event.payload.isFullScreen }
                : NO_EFFECT;
        default:
            return NO_EFFECT;
    }
}

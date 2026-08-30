import type { LiteEvent } from 'react-scan/lite';
import { instrument } from 'react-scan/lite';

interface ReactScanGlobal {
    caxriReactScan?: {
        error?: boolean;
        handle?: ReturnType<typeof instrument>;
        profilingAvailable?: boolean;
    };
}

const performanceGlobal = globalThis as ReactScanGlobal;
const runtime: NonNullable<ReactScanGlobal['caxriReactScan']> = {};
try {
    /**
     * React-scan owns React's profiling-hook channel for this opt-in run and can conflict with the React DevTools
     * Timeline Profiler. The normal entry never imports this module; see docs/renderer-performance.md.
     */
    runtime.handle = instrument({
        includeFiberTree: true,
        includeFiberIdentity: false,
        includeFiberSource: false,
        includeLaneLabels: false,
        includeProfilingHooks: true,
        maxFibersPerCommit: 500,
        minFiberActualDurationMs: 0.1,
        recordChangeDescriptions: false,
        onEvent(event: LiteEvent) {
            if (event.kind === 'profiling-hooks-status' && event.available !== undefined)
                runtime.profilingAvailable = event.available;
        },
    });
} catch {
    /**
     * Optional attribution must never prevent the Workbench from loading.
     */
    runtime.error = true;
}
performanceGlobal.caxriReactScan = runtime;

await import('../../main');

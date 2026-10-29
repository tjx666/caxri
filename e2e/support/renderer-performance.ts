import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

/**
 * The `caxriPerformance` API the Renderer exposes in development, E2E, and profiling builds; see
 * `docs/renderer-performance.md`. React Profiler counts are real only in a `CAXRI_REACT_PROFILING=1` build.
 */
interface RendererPerformanceBrowserApi {
    begin(action: RendererPerformanceScenarioDiagnostic['action']): string;
    end(scenarioId: string): RendererPerformanceScenarioDiagnostic;
    status(): {
        frameSampleCount: number;
        pendingRequestCount: number;
        scenarioId: string | null;
    };
}

export type RendererPerformanceWindow = typeof globalThis & {
    caxriPerformance?: RendererPerformanceBrowserApi;
};

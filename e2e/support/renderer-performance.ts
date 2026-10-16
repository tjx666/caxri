import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

interface RendererPerformanceBrowserApi {
    begin(action: 'session.switch'): string;
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

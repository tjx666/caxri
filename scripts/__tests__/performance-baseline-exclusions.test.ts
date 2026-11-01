import { describe, expect, it } from 'vitest';

import { isExcludedPerformanceMetric } from '../performance-baseline';

describe('isExcludedPerformanceMetric for the Agent Chat switch receipt', () => {
    it('gates the Agent Chat switch p50 times, React durations, and stable render counts only', () => {
        for (const gated of [
            'scenarios.cold.readableMs.p50',
            'scenarios.keptAlive.interactiveMs.p50',
            'scenarios.uncached.react.surfaces.workbench.actualDurationMs.p50',
            'scenarios.cached.react.surfaces.primary-sidebar.renders.p50',
            'scenarios.keptAlive.react.surfaces.workbench.renders.p50',
            'scenarios.keptAlive.react.commitCount.p50',
            'scenarios.cold.readRequests.p50',
            'scenarios.cached.longestAnimationFrameMs.p50',
            'hiddenStreaming.workbench.actualDurationMs',
        ]) {
            expect(isExcludedPerformanceMetric(gated), gated).toBe(false);
        }
        for (const excluded of [
            'turnCount',
            'scenarios.cold.iterations',
            'hiddenStreaming.commitCount',
            'hiddenStreaming.workbench.renders',
            'hiddenStreaming.keptAliveStreaming.readableMs.p50',
            'scenarios.cold.readableMs.p95',
            'scenarios.keptAlive.longestAnimationFrameMs.p50',
            'scenarios.cached.react.surfaces.workbench.actualDurationMs.max',
            'scenarios.uncached.react.commitCount.p50',
            'scenarios.cold.react.surfaces.workbench.renders.p50',
        ]) {
            expect(isExcludedPerformanceMetric(excluded), excluded).toBe(true);
        }
    });
});

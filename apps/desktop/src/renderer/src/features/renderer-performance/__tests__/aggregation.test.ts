import { describe, expect, it } from 'vitest';

import { summarizeRendererPerformance } from '../aggregation';

describe('Renderer performance aggregation', () => {
    it('groups Profiler surfaces by commit and derives frame gaps without retaining content', () => {
        const summary = summarizeRendererPerformance({
            diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
            scenarioId: '08f3dd5f-5c18-49e2-bc25-e46262ec624d',
            action: 'benchmark.renderer',
            buildMode: 'profiling',
            startedAt: 100,
            endedAt: 850,
            documentVisible: true,
            documentFocused: false,
            visibilityInterrupted: false,
            focusInterrupted: false,
            capabilities: {
                longAnimationFrame: 'available',
                eventTiming: 'available',
                reactProfiler: 'available',
                reactScan: 'active',
            },
            reactProfiles: [
                {
                    surface: 'workbench',
                    phase: 'mount',
                    actualDurationMs: 20,
                    baseDurationMs: 40,
                    commitTime: 150,
                },
                {
                    surface: 'primary-sidebar',
                    phase: 'mount',
                    actualDurationMs: 5,
                    baseDurationMs: 8,
                    commitTime: 150,
                },
                {
                    surface: 'workbench',
                    phase: 'update',
                    actualDurationMs: 10,
                    baseDurationMs: 36,
                    commitTime: 250,
                },
                {
                    surface: 'workbench',
                    phase: 'nested-update',
                    actualDurationMs: 30,
                    baseDurationMs: 42,
                    commitTime: 350,
                },
            ],
            longAnimationFrames: [
                { durationMs: 64, blockingDurationMs: 16, styleAndLayoutDurationMs: 8 },
                { durationMs: 48, blockingDurationMs: 8, styleAndLayoutDurationMs: 4 },
            ],
            interactions: [
                {
                    durationMs: 48,
                    inputDelayMs: 8,
                    processingDurationMs: 24,
                    presentationDelayMs: 16,
                },
            ],
            frameTimestamps: [0, 16, 32, 80],
            reactScanCommits: [
                {
                    commitId: 1,
                    componentName: 'TerminalPane',
                    renderCount: 3,
                    totalDurationMs: 12,
                    treeTruncated: false,
                },
                {
                    commitId: 2,
                    componentName: 'TerminalPane',
                    renderCount: 1,
                    totalDurationMs: 6,
                    treeTruncated: false,
                },
                {
                    commitId: 2,
                    componentName: 'Private/Project.tsx',
                    renderCount: 2,
                    totalDurationMs: 50,
                    treeTruncated: true,
                },
                {
                    commitId: 2,
                    componentName: 'Anonymous',
                    renderCount: 1,
                    totalDurationMs: 100,
                    treeTruncated: false,
                },
                {
                    commitId: 2,
                    componentName: 'div',
                    renderCount: 1,
                    totalDurationMs: 100,
                    treeTruncated: false,
                },
            ],
            truncated: false,
        });

        expect(summary).toMatchObject({
            kind: 'renderer-performance-scenario',
            durationMs: 750,
            react: {
                commitCount: 3,
                profiledRenderCount: 4,
                mountRenderCount: 2,
                updateRenderCount: 1,
                nestedUpdateRenderCount: 1,
                actualDurationP50Ms: 10,
                actualDurationP95Ms: 30,
                actualDurationMaxMs: 30,
                baseDurationMaxMs: 42,
                surfaces: {
                    'primary-sidebar': {
                        profiledRenderCount: 1,
                        actualDurationP50Ms: 5,
                        actualDurationP95Ms: 5,
                        actualDurationMaxMs: 5,
                        actualDurationTotalMs: 5,
                        baseDurationMaxMs: 8,
                    },
                    'workbench': {
                        profiledRenderCount: 3,
                        actualDurationP50Ms: 20,
                        actualDurationP95Ms: 30,
                        actualDurationMaxMs: 30,
                        actualDurationTotalMs: 60,
                        baseDurationMaxMs: 42,
                    },
                    'secondary-sidebar': {
                        profiledRenderCount: 0,
                        actualDurationP50Ms: 0,
                        actualDurationP95Ms: 0,
                        actualDurationMaxMs: 0,
                        actualDurationTotalMs: 0,
                        baseDurationMaxMs: 0,
                    },
                },
            },
            longAnimationFrames: {
                count: 2,
                totalDurationMs: 112,
                maxDurationMs: 64,
                totalBlockingDurationMs: 24,
                maxBlockingDurationMs: 16,
                maxStyleAndLayoutDurationMs: 8,
            },
            interactions: {
                count: 1,
                maxDurationMs: 48,
                maxInputDelayMs: 8,
                maxProcessingDurationMs: 24,
                maxPresentationDelayMs: 16,
            },
            frames: {
                sampleCount: 3,
                estimatedRefreshIntervalMs: 16,
                intervalP50Ms: 16,
                intervalP95Ms: 48,
                maxIntervalMs: 48,
                missedFrameCount: 2,
            },
            reactScan: {
                commitCount: 2,
                renderCount: 8,
                slowestComponent: 'TerminalPane',
                slowestComponentRenderCount: 4,
                slowestComponentTotalDurationMs: 18,
                treeTruncated: true,
            },
            truncated: true,
        });
        expect(JSON.stringify(summary)).not.toContain('Private/Project.tsx');
    });

    it('returns internally consistent zero summaries when observers collect no samples', () => {
        const summary = summarizeRendererPerformance({
            diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
            scenarioId: '08f3dd5f-5c18-49e2-bc25-e46262ec624d',
            action: 'session.switch',
            buildMode: 'development',
            startedAt: 100,
            endedAt: 100,
            documentVisible: false,
            documentFocused: false,
            visibilityInterrupted: false,
            focusInterrupted: false,
            capabilities: {
                longAnimationFrame: 'unavailable',
                eventTiming: 'unavailable',
                reactProfiler: 'disabled',
                reactScan: 'disabled',
            },
            reactProfiles: [],
            longAnimationFrames: [],
            interactions: [],
            frameTimestamps: [],
            reactScanCommits: [],
            truncated: false,
        });

        expect(summary.react).toMatchObject({
            commitCount: 0,
            profiledRenderCount: 0,
            surfaces: {
                'primary-sidebar': { profiledRenderCount: 0 },
                'workbench': { profiledRenderCount: 0 },
                'secondary-sidebar': { profiledRenderCount: 0 },
            },
        });
        expect(summary.frames).toEqual({
            sampleCount: 0,
            estimatedRefreshIntervalMs: 0,
            intervalP50Ms: 0,
            intervalP95Ms: 0,
            maxIntervalMs: 0,
            missedFrameCount: 0,
        });
        expect(summary.reactScan.slowestComponent).toBeNull();
    });
});

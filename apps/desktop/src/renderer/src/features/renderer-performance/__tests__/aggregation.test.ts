import { describe, expect, it } from 'vitest';

import { summarizeRendererPerformance } from '../aggregation';

describe('Renderer performance aggregation', () => {
    it('groups Profiler surfaces by commit and derives frame gaps without retaining content', () => {
        const summary = summarizeRendererPerformance({
            diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
            scenarioId: '08f3dd5f-5c18-49e2-bc25-e46262ec624d',
            action: 'session.switch',
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
            requests: [
                { request: 'session.select', durationMs: 18 },
                { request: 'app.bootstrap', durationMs: 10 },
                { request: 'app.bootstrap', durationMs: 14 },
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
            terminalAttachedCount: 3,
            terminalReusedCount: 1,
            terminalStages: [
                { durationMs: 12, stage: 'xterm-create' },
                { durationMs: 8, stage: 'xterm-create' },
                { durationMs: 4, stage: 'webgl-attach' },
                { durationMs: 30, stage: 'snapshot-replay' },
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
            requests: {
                sessionSelect: { count: 1, totalDurationMs: 18, maxDurationMs: 18 },
                appBootstrap: { count: 2, totalDurationMs: 24, maxDurationMs: 14 },
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
            /**
             * The stage breakdown is what makes the keep-alive claim checkable: a Session switch that reuses a
             * kept-alive pane reports reused attachments and no `xterm-create` at all (issue #657).
             */
            terminals: {
                attachedCount: 3,
                reusedCount: 1,
                stages: {
                    snapshotReplay: { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
                    webglAttach: { count: 1, totalDurationMs: 4, maxDurationMs: 4 },
                    xtermCreate: { count: 2, totalDurationMs: 20, maxDurationMs: 12 },
                },
            },
            truncated: false,
        });
        expect(summary).not.toHaveProperty('reactScan');
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
            },
            reactProfiles: [],
            requests: [],
            longAnimationFrames: [],
            interactions: [],
            frameTimestamps: [],
            terminalAttachedCount: 0,
            terminalReusedCount: 0,
            terminalStages: [],
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
        expect(summary.requests).toEqual({
            sessionSelect: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
            appBootstrap: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        });
        expect(summary).not.toHaveProperty('reactScan');
    });
});

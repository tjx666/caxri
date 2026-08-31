import { describe, expect, it } from 'vitest';

import { rendererDiagnosticSchema, rendererPerformanceSurfaces } from '../renderer-diagnostic.js';

const validDiagnostic = {
    kind: 'terminal-renderer',
    diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
    terminalId: 'terminal-1',
    mode: 'dom',
    reason: 'context-loss',
    trigger: 'webgl-context-loss',
    preference: 'auto',
    contextLossCount: 1,
    redrawCount: 1,
    recoveryResult: 'dom-restored',
    retryAttemptCount: 1,
    retryDelayMs: 1_000,
    retryLimit: 3,
    retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
    retryState: 'scheduled',
    correlationId: '75f635fb-b53f-44cf-a99d-a731f97455d8',
    receivedBytes: 128,
    droppedBytes: 0,
    paneActive: true,
    terminalProcessRunning: true,
    agentTerminal: true,
    documentVisible: true,
    documentFocused: true,
    terminalFocused: false,
};

const validResizeBurstDiagnostic = {
    kind: 'terminal-resize-burst',
    diagnosticId: '5c85eb53-a828-4656-b7ad-1e77bf2baf27',
    terminalId: 'terminal-1',
    side: 'renderer-xterm',
    sampleCount: 4,
    changeCount: 2,
    startCols: 120,
    startRows: 40,
    minCols: 4,
    minRows: 12,
    maxCols: 120,
    maxRows: 40,
    finalCols: 80,
    finalRows: 30,
    durationMs: 96,
    flushReason: 'quiet',
    truncated: false,
    localAppliedCount: 2,
    requestCount: 2,
};

const validPerformanceScenarioDiagnostic = {
    kind: 'renderer-performance-scenario',
    diagnosticId: 'd66947a8-0da0-4a4b-8629-a7694116d8e5',
    scenarioId: '08f3dd5f-5c18-49e2-bc25-e46262ec624d',
    entry: 'workbench',
    action: 'session.switch',
    buildMode: 'profiling',
    durationMs: 750,
    documentVisible: true,
    documentFocused: false,
    visibilityInterrupted: false,
    focusInterrupted: false,
    capabilities: {
        longAnimationFrame: 'available',
        eventTiming: 'available',
        reactProfiler: 'available',
    },
    react: {
        commitCount: 3,
        profiledRenderCount: 5,
        mountRenderCount: 1,
        updateRenderCount: 3,
        nestedUpdateRenderCount: 1,
        actualDurationP50Ms: 12.5,
        actualDurationP95Ms: 24,
        actualDurationMaxMs: 24,
        baseDurationMaxMs: 41,
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
                actualDurationP50Ms: 12.5,
                actualDurationP95Ms: 24,
                actualDurationMaxMs: 24,
                actualDurationTotalMs: 38,
                baseDurationMaxMs: 41,
            },
            'secondary-sidebar': {
                profiledRenderCount: 1,
                actualDurationP50Ms: 7,
                actualDurationP95Ms: 7,
                actualDurationMaxMs: 7,
                actualDurationTotalMs: 7,
                baseDurationMaxMs: 10,
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
        sampleCount: 40,
        estimatedRefreshIntervalMs: 16.67,
        intervalP50Ms: 16.67,
        intervalP95Ms: 32,
        maxIntervalMs: 48,
        missedFrameCount: 3,
    },
    truncated: false,
};

describe('Renderer diagnostic contract', () => {
    it('accepts bounded content-free terminal renderer state', () => {
        expect(rendererDiagnosticSchema.parse(validDiagnostic)).toEqual(validDiagnostic);
    });

    it('accepts a bounded content-free Renderer resize burst', () => {
        expect(rendererDiagnosticSchema.parse(validResizeBurstDiagnostic)).toEqual(
            validResizeBurstDiagnostic,
        );
    });

    it('accepts a bounded content-free Renderer performance scenario', () => {
        expect(rendererPerformanceSurfaces).toEqual([
            'primary-sidebar',
            'workbench',
            'secondary-sidebar',
        ]);
        expect(rendererDiagnosticSchema.parse(validPerformanceScenarioDiagnostic)).toEqual(
            validPerformanceScenarioDiagnostic,
        );
    });

    it('rejects arbitrary fields and unbounded identifiers', () => {
        expect(
            rendererDiagnosticSchema.safeParse({ ...validDiagnostic, terminalOutput: 'secret' })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({ ...validDiagnostic, path: '/private/project' })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({ ...validDiagnostic, environment: { TOKEN: 'x' } })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({
                ...validDiagnostic,
                terminalId: 'x'.repeat(257),
            }).success,
        ).toBe(false);
    });

    it('rejects sensitive, unknown, and out-of-bounds resize burst fields', () => {
        for (const forbidden of [
            { terminalOutput: 'private transcript' },
            { command: 'private-command' },
            { path: '/private/project' },
            { environment: { TOKEN: 'secret' } },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validResizeBurstDiagnostic,
                    ...forbidden,
                }).success,
            ).toBe(false);
        }

        for (const invalid of [
            { side: 'terminal-host-pty' },
            { sampleCount: 10_001 },
            { changeCount: -1 },
            { startCols: 1 },
            { minRows: 0 },
            { maxCols: 1_001 },
            { finalRows: 1_001 },
            { durationMs: 5_001 },
            { localAppliedCount: 10_001 },
            { requestCount: 10_001 },
            { flushReason: 'terminal-output' },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validResizeBurstDiagnostic,
                    ...invalid,
                }).success,
            ).toBe(false);
        }
    });

    it('rejects internally inconsistent resize burst aggregates', () => {
        for (const invalid of [
            { changeCount: validResizeBurstDiagnostic.sampleCount },
            { localAppliedCount: validResizeBurstDiagnostic.sampleCount + 1 },
            { requestCount: validResizeBurstDiagnostic.sampleCount + 1 },
            { minCols: validResizeBurstDiagnostic.maxCols + 1 },
            { minCols: validResizeBurstDiagnostic.finalCols + 1 },
            { maxRows: validResizeBurstDiagnostic.finalRows - 1 },
            { startRows: validResizeBurstDiagnostic.minRows - 1 },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validResizeBurstDiagnostic,
                    ...invalid,
                }).success,
            ).toBe(false);
        }
    });

    it('rejects sensitive, unbounded, and inconsistent performance summaries', () => {
        for (const forbidden of [
            { domText: 'private project title' },
            { sourceUrl: 'file:///Users/example/private.tsx' },
            { path: '/private/project' },
            { props: { token: 'secret' } },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validPerformanceScenarioDiagnostic,
                    ...forbidden,
                }).success,
            ).toBe(false);
        }

        for (const invalid of [
            { action: 'arbitrary.user.value' },
            { action: 'benchmark.renderer' },
            { action: 'terminal.resize' },
            { action: 'files.expand' },
            { action: 'editor.open' },
            { durationMs: 120_001 },
            {
                requests: {
                    ...validPerformanceScenarioDiagnostic.requests,
                    appBootstrap: { count: 0, totalDurationMs: 1, maxDurationMs: 1 },
                },
            },
            { react: { ...validPerformanceScenarioDiagnostic.react, commitCount: 6 } },
            {
                react: {
                    ...validPerformanceScenarioDiagnostic.react,
                    actualDurationP95Ms: 25,
                },
            },
            {
                react: {
                    ...validPerformanceScenarioDiagnostic.react,
                    surfaces: {
                        ...validPerformanceScenarioDiagnostic.react.surfaces,
                        workbench: {
                            ...validPerformanceScenarioDiagnostic.react.surfaces.workbench,
                            actualDurationP95Ms: 25,
                        },
                    },
                },
            },
            {
                react: {
                    ...validPerformanceScenarioDiagnostic.react,
                    surfaces: {
                        ...validPerformanceScenarioDiagnostic.react.surfaces,
                        'app-shell': validPerformanceScenarioDiagnostic.react.surfaces.workbench,
                    },
                },
            },
            {
                react: {
                    ...validPerformanceScenarioDiagnostic.react,
                    surfaces: {
                        ...validPerformanceScenarioDiagnostic.react.surfaces,
                        workbench: {
                            ...validPerformanceScenarioDiagnostic.react.surfaces.workbench,
                            profiledRenderCount: 4,
                        },
                    },
                },
            },
            {
                frames: {
                    ...validPerformanceScenarioDiagnostic.frames,
                    sampleCount: 20_001,
                },
            },
            {
                capabilities: {
                    ...validPerformanceScenarioDiagnostic.capabilities,
                    reactScan: 'active',
                },
            },
            {
                interactions: {
                    ...validPerformanceScenarioDiagnostic.interactions,
                    count: 0,
                },
            },
            {
                capabilities: {
                    ...validPerformanceScenarioDiagnostic.capabilities,
                    longAnimationFrame: 'unavailable',
                },
            },
            {
                capabilities: {
                    ...validPerformanceScenarioDiagnostic.capabilities,
                    reactProfiler: 'disabled',
                },
            },
            {
                longAnimationFrames: {
                    ...validPerformanceScenarioDiagnostic.longAnimationFrames,
                    count: 2_001,
                },
            },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validPerformanceScenarioDiagnostic,
                    ...invalid,
                }).success,
            ).toBe(false);
        }
    });
});

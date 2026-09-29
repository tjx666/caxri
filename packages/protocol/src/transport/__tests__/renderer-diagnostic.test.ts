import { describe, expect, it } from 'vitest';

import { rendererDiagnosticSchema } from '../renderer-diagnostic.js';
import { rendererPerformanceSurfaces } from '../renderer-performance-diagnostic.js';

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
    visibilityRestoreCoalescedCount: 2,
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

const validOsc52ClipboardWriteFailureDiagnostic = {
    kind: 'terminal-osc52-clipboard-write-failure',
    diagnosticId: 'bc3db163-6b13-4b50-81f4-126c55cc429b',
    terminalId: 'terminal-1',
    errorCategory: 'not-allowed',
    clipboardWritePermission: 'granted',
    documentVisible: true,
    documentFocused: true,
    secureContext: true,
    terminalFocused: true,
    userActivationActive: false,
    userActivationHasBeenActive: true,
};

const validEditorWorkerStallDiagnostic = {
    kind: 'editor-worker-stall',
    diagnosticId: 'a1f0e1cd-6b42-4f27-9a7c-0d4f5a9c2f18',
    surface: 'git-diff',
    outcome: 'timeout',
    waitMs: 8_000,
    workerRoundTrip: 'no-reply',
    workerRoundTripMs: null,
    workerBroadcast: 'ok',
    documentVisible: true,
    navigationType: 'reload',
    pageAgeMs: 3_600_000,
    originalLineCount: 240,
    modifiedLineCount: 252,
    identicalModels: false,
    diffOpenCount: 6,
    stallCount: 6,
    editorWorkersCreated: 1,
    editorWorkersStarted: 1,
    editorWorkersStartupStalled: 0,
    editorWorkersStartupStalledNow: 0,
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
    terminals: {
        attachedCount: 3,
        reusedCount: 1,
        stages: {
            snapshotReplay: { count: 1, totalDurationMs: 30, maxDurationMs: 30 },
            webglAttach: { count: 1, totalDurationMs: 4, maxDurationMs: 4 },
            xtermCreate: { count: 2, totalDurationMs: 20, maxDurationMs: 12 },
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
        expect(
            rendererDiagnosticSchema.safeParse({ ...validDiagnostic, trigger: 'manual-retry' })
                .success,
        ).toBe(true);
    });

    it('accepts a session GPU incident budget transition and rejects open-ended fields', () => {
        const validTransition = {
            kind: 'gpu-incident-budget',
            diagnosticId: '5c85eb53-a828-4656-b7ad-1e77bf2baf27',
            transition: 'pinned',
            cause: 'gpu-incident',
            correlationId: '75f635fb-b53f-44cf-a99d-a731f97455d8',
            incidentCount: 3,
            contextLossEpisodeCount: 1,
            threshold: 3,
            preference: 'on',
        };
        expect(rendererDiagnosticSchema.parse(validTransition)).toEqual(validTransition);
        expect(
            rendererDiagnosticSchema.safeParse({
                ...validTransition,
                transition: 'reset',
                cause: 'manual-retry',
            }).success,
        ).toBe(true);
        const contextLossTransition = {
            kind: 'gpu-incident-budget',
            diagnosticId: validTransition.diagnosticId,
            transition: 'pinned',
            cause: 'context-loss',
            incidentCount: 0,
            contextLossEpisodeCount: 3,
            threshold: 3,
            preference: null,
        };
        expect(rendererDiagnosticSchema.parse(contextLossTransition)).toEqual(
            contextLossTransition,
        );

        expect(
            rendererDiagnosticSchema.safeParse({ ...validTransition, cause: 'user said so' })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({ ...validTransition, correlationId: 'incident' })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({ ...validTransition, message: 'GPU crashed' })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({ ...validTransition, incidentCount: 10_001 })
                .success,
        ).toBe(false);
    });

    it('accepts a bounded content-free Renderer resize burst', () => {
        expect(rendererDiagnosticSchema.parse(validResizeBurstDiagnostic)).toEqual(
            validResizeBurstDiagnostic,
        );
    });

    it('accepts a seeded resize burst where changeCount equals sampleCount', () => {
        const seededDiagnostic = {
            ...validResizeBurstDiagnostic,
            sampleCount: 1,
            changeCount: 1,
            localAppliedCount: 1,
            requestCount: 1,
        };
        expect(rendererDiagnosticSchema.parse(seededDiagnostic)).toEqual(seededDiagnostic);
    });

    it('accepts a bounded content-free editor Worker stall', () => {
        expect(rendererDiagnosticSchema.parse(validEditorWorkerStallDiagnostic)).toEqual(
            validEditorWorkerStallDiagnostic,
        );
    });

    it('accepts historical startup stalls after the Worker begins replying', () => {
        const recovered = {
            ...validEditorWorkerStallDiagnostic,
            outcome: 'recovered',
            editorWorkersCreated: 1,
            editorWorkersStarted: 1,
            editorWorkersStartupStalled: 1,
            editorWorkersStartupStalledNow: 0,
        };
        expect(rendererDiagnosticSchema.parse(recovered)).toEqual(recovered);
        expect(
            rendererDiagnosticSchema.safeParse({ ...recovered, editorWorkersStartupStalledNow: 1 })
                .success,
        ).toBe(false);
        expect(
            rendererDiagnosticSchema.safeParse({ ...recovered, editorWorkersStartupStalled: 2 })
                .success,
        ).toBe(false);
    });

    it('accepts a stall whose Worker was destroyed and recreated instead of answering late', () => {
        const workerRecreated = {
            ...validEditorWorkerStallDiagnostic,
            outcome: 'worker-recreated',
            workerRoundTrip: 'skipped',
            workerRoundTripMs: null,
            workerBroadcast: 'skipped',
        };
        expect(rendererDiagnosticSchema.parse(workerRecreated)).toEqual(workerRecreated);
    });

    it('carries every combination of the two Worker return paths', () => {
        // Each pair is a different conclusion for a reader of desktop.jsonl, which is the whole reason both are
        // recorded: the Worker never ran, only the Renderer-internal reply was lost (issue #962), or messaging was
        // healthy and the diff computation itself was slow.
        for (const paths of [
            { workerRoundTrip: 'no-reply', workerRoundTripMs: null, workerBroadcast: 'no-reply' },
            { workerRoundTrip: 'no-reply', workerRoundTripMs: null, workerBroadcast: 'ok' },
            { workerRoundTrip: 'ok', workerRoundTripMs: 4, workerBroadcast: 'ok' },
            { workerRoundTrip: 'ok', workerRoundTripMs: 4, workerBroadcast: 'unsupported' },
            // The recovery record probes nothing, so both paths report that rather than inventing a silence.
            { workerRoundTrip: 'skipped', workerRoundTripMs: null, workerBroadcast: 'skipped' },
        ]) {
            const diagnostic = { ...validEditorWorkerStallDiagnostic, ...paths };
            expect(rendererDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
        }
    });

    it('rejects sensitive, unbounded, and inconsistent editor Worker stall fields', () => {
        for (const invalid of [
            { ...validEditorWorkerStallDiagnostic, repositoryPath: '/Users/someone/repo' },
            { ...validEditorWorkerStallDiagnostic, outcome: 'unknown' },
            { ...validEditorWorkerStallDiagnostic, waitMs: -1 },
            { ...validEditorWorkerStallDiagnostic, workerRoundTrip: 'maybe' },
            { ...validEditorWorkerStallDiagnostic, workerBroadcast: 'maybe' },
            { ...validEditorWorkerStallDiagnostic, navigationType: 'refresh' },
            { ...validEditorWorkerStallDiagnostic, pageAgeMs: -1 },
            // An `ok` round trip without its duration would report a reply nobody can time.
            { ...validEditorWorkerStallDiagnostic, workerRoundTrip: 'ok', workerRoundTripMs: null },
            // A broadcast reported as `skipped` while the direct path was really probed would erase the one contrast
            // this record exists for, and the reverse would claim an observation nothing made.
            { ...validEditorWorkerStallDiagnostic, workerBroadcast: 'skipped' },
            {
                ...validEditorWorkerStallDiagnostic,
                workerRoundTrip: 'skipped',
                workerRoundTripMs: null,
            },
            {
                ...validEditorWorkerStallDiagnostic,
                workerRoundTrip: 'construct-failed',
                workerRoundTripMs: null,
            },
            // More stalls than opened diffs is arithmetically impossible and would mislead triage.
            { ...validEditorWorkerStallDiagnostic, diffOpenCount: 1, stallCount: 2 },
        ])
            expect(rendererDiagnosticSchema.safeParse(invalid).success).toBe(false);
    });

    it('accepts a bounded content-free OSC 52 clipboard write failure', () => {
        expect(rendererDiagnosticSchema.parse(validOsc52ClipboardWriteFailureDiagnostic)).toEqual(
            validOsc52ClipboardWriteFailureDiagnostic,
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

    it('rejects sensitive and open-ended OSC 52 clipboard failure fields', () => {
        for (const forbidden of [
            { clipboardText: 'private clipboard content' },
            { errorMessage: 'private error detail' },
            { errorName: 'NotAllowedError' },
            { stack: 'private stack' },
            { terminalOutput: 'private transcript' },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validOsc52ClipboardWriteFailureDiagnostic,
                    ...forbidden,
                }).success,
            ).toBe(false);
        }

        for (const invalid of [
            { errorCategory: 'arbitrary-error-name' },
            { clipboardWritePermission: 'arbitrary-permission' },
            { userActivationActive: 'unknown' },
        ]) {
            expect(
                rendererDiagnosticSchema.safeParse({
                    ...validOsc52ClipboardWriteFailureDiagnostic,
                    ...invalid,
                }).success,
            ).toBe(false);
        }
    });

    it('rejects internally inconsistent resize burst aggregates', () => {
        for (const invalid of [
            { changeCount: validResizeBurstDiagnostic.sampleCount + 1 },
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

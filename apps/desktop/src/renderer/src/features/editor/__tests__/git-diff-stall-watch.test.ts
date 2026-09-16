import type { EditorWorkerStallDiagnostic } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerRoundTripResult } from '../../../lib/worker-round-trip';
import { GitDiffStallWatch } from '../git-diff-stall-watch';

function createWatch(
    overrides: {
        roundTrip?: WorkerRoundTripResult;
        minimumReportIntervalMs?: number;
        documentVisible?: boolean;
        pageAgeMs?: number;
        now?: () => number;
        startupStalledNow?: number;
    } = {},
) {
    const reported: EditorWorkerStallDiagnostic[] = [];
    let identifier = 0;
    const watch = new GitDiffStallWatch({
        reportDiagnostic: (diagnostic) => reported.push(diagnostic),
        probeRoundTrip: () =>
            Promise.resolve(
                overrides.roundTrip ?? {
                    outcome: 'no-reply' as const,
                    durationMs: null,
                    broadcast: 'ok' as const,
                },
            ),
        readWorkerStartup: () => ({
            created: 3,
            started: 3 - (overrides.startupStalledNow ?? 0),
            stalled: overrides.startupStalledNow ?? 0,
            recovered: 0,
            stalledNow: overrides.startupStalledNow ?? 0,
        }),
        isDocumentVisible: () => overrides.documentVisible ?? false,
        readPageLoad: () => ({
            navigationType: 'reload',
            pageAgeMs: overrides.pageAgeMs ?? 3_600_000,
        }),
        now: overrides.now ?? (() => Date.now()),
        createDiagnosticId: () => `00000000-0000-4000-8000-00000000000${(identifier += 1)}`,
        timeoutMs: 5,
        minimumReportIntervalMs: overrides.minimumReportIntervalMs ?? 0,
    });
    return { reported, watch };
}

const models = () => ({ originalLineCount: 12, modifiedLineCount: 15, identicalModels: false });

describe('Git diff stall watch', () => {
    it('stays silent for a diff that completes', async () => {
        const { reported, watch } = createWatch();

        watch.observe({ waitForDiff: async () => {}, readModels: models });
        await vi.waitFor(() => expect(true).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(reported).toEqual([]);
    });

    it('records a stalled diff with the Worker round-trip that explains it', async () => {
        const { reported, watch } = createWatch();

        watch.observe({ waitForDiff: () => new Promise(() => {}), readModels: models });
        await vi.waitFor(() => expect(reported).toHaveLength(1));

        expect(reported[0]).toMatchObject({
            kind: 'editor-worker-stall',
            surface: 'git-diff',
            outcome: 'timeout',
            // A silent direct path next to a live broadcast is the shape from issue #962: the Worker ran and answered,
            // and only the reply into this Renderer was lost.
            workerRoundTrip: 'no-reply',
            workerRoundTripMs: null,
            workerBroadcast: 'ok',
            documentVisible: false,
            navigationType: 'reload',
            pageAgeMs: 3_600_000,
            originalLineCount: 12,
            modifiedLineCount: 15,
            identicalModels: false,
            diffOpenCount: 1,
            stallCount: 1,
            editorWorkersCreated: 3,
            editorWorkersStarted: 3,
            editorWorkersStartupStalled: 0,
            editorWorkersStartupStalledNow: 0,
        });
        expect(reported[0]?.waitMs).toBeGreaterThanOrEqual(5);
    });

    it('names a Worker that never started, so the surface can offer the recovery that matches it', async () => {
        const outcomes: string[] = [];
        const { watch } = createWatch({ startupStalledNow: 1 });

        watch.observe({
            waitForDiff: () => new Promise(() => {}),
            readModels: models,
            onOutcome: (outcome) => outcomes.push(outcome),
        });
        await vi.waitFor(() => expect(outcomes).toEqual(['worker-not-started']));
    });

    it('reports a plain stall while every Worker this window created did start', async () => {
        const outcomes: string[] = [];
        const { watch } = createWatch();

        watch.observe({
            waitForDiff: () => new Promise(() => {}),
            readModels: models,
            onOutcome: (outcome) => outcomes.push(outcome),
        });
        await vi.waitFor(() => expect(outcomes).toEqual(['stalled']));
    });

    it('records the recovery of a diff that arrives after its stall was reported', async () => {
        const { reported, watch } = createWatch();
        const diff = Promise.withResolvers<void>();

        watch.observe({ waitForDiff: () => diff.promise, readModels: models });
        await vi.waitFor(() => expect(reported).toHaveLength(1));
        diff.resolve();
        await vi.waitFor(() => expect(reported).toHaveLength(2));

        expect(reported[1]).toMatchObject({
            outcome: 'recovered',
            workerRoundTrip: 'skipped',
            workerBroadcast: 'skipped',
        });
    });

    it('carries a healthy probe through unchanged, so a slow diff is not read as broken messaging', async () => {
        const { reported, watch } = createWatch({
            roundTrip: { outcome: 'ok', durationMs: 4, broadcast: 'ok' },
        });

        watch.observe({ waitForDiff: () => new Promise(() => {}), readModels: models });
        await vi.waitFor(() => expect(reported).toHaveLength(1));

        expect(reported[0]).toMatchObject({
            workerRoundTrip: 'ok',
            workerRoundTripMs: 4,
            workerBroadcast: 'ok',
        });
    });

    it('keeps counting rate-limited stalls so the next record carries their volume', async () => {
        const { reported, watch } = createWatch({ minimumReportIntervalMs: 60_000 });

        for (let index = 0; index < 3; index += 1)
            watch.observe({ waitForDiff: () => new Promise(() => {}), readModels: models });
        await vi.waitFor(() => expect(reported).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(reported).toHaveLength(1);
        expect(reported[0]).toMatchObject({ diffOpenCount: 3, stallCount: 1 });
    });

    it('reports nothing once the surface is cancelled', async () => {
        const { reported, watch } = createWatch();

        const cancel = watch.observe({
            waitForDiff: () => new Promise(() => {}),
            readModels: models,
        });
        cancel();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(reported).toEqual([]);
    });

    it('drops a pending recovery when the surface is cancelled after its stall', async () => {
        const { reported, watch } = createWatch();
        const diff = Promise.withResolvers<void>();

        const cancel = watch.observe({ waitForDiff: () => diff.promise, readModels: models });
        await vi.waitFor(() => expect(reported).toHaveLength(1));
        cancel();
        diff.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(reported).toHaveLength(1);
    });

    it('saturates durations past the contract instead of losing the whole record', async () => {
        let clock = 0;
        const { reported, watch } = createWatch({
            now: () => clock,
            pageAgeMs: 99_999_999_999,
        });

        watch.observe({ waitForDiff: () => new Promise(() => {}), readModels: models });
        clock = 99_999_999;
        await vi.waitFor(() => expect(reported).toHaveLength(1));

        // Out-of-range numbers are rejected by the diagnostic contract, and a rejected record is the silence this
        // watcher exists to end, so both ceilings clamp rather than drop.
        expect(reported[0]).toMatchObject({ waitMs: 600_000, pageAgeMs: 2_592_000_000 });
    });

    it('still records a stall when the diff models can no longer be read', async () => {
        const { reported, watch } = createWatch();

        watch.observe({
            waitForDiff: () => new Promise(() => {}),
            readModels: () => {
                throw new Error('model disposed');
            },
        });
        await vi.waitFor(() => expect(reported).toHaveLength(1));

        expect(reported[0]).toMatchObject({
            originalLineCount: 0,
            modifiedLineCount: 0,
            identicalModels: false,
        });
    });

    it('tells the surface a diff computed, so it can stop showing a comparison in progress', async () => {
        const { watch } = createWatch();
        const outcomes: string[] = [];

        watch.observe({
            waitForDiff: async () => {},
            readModels: models,
            onOutcome: (outcome) => outcomes.push(outcome),
        });
        await vi.waitFor(() => expect(outcomes).toEqual(['computed']));
    });

    it('tells the surface about a stall even when the record is rate limited', async () => {
        // The floor bounds how often a stall is written to the log. What the user is told is not a log volume
        // question: two panes with no highlights read as "no changes" whether or not this stall was recorded.
        const { reported, watch } = createWatch({ minimumReportIntervalMs: 60_000 });
        const outcomes: string[] = [];
        const observation = {
            waitForDiff: () => new Promise(() => {}),
            readModels: models,
            onOutcome: (outcome: string) => outcomes.push(outcome),
        };

        watch.observe(observation);
        await vi.waitFor(() => expect(reported).toHaveLength(1));
        watch.observe(observation);
        await vi.waitFor(() => expect(outcomes).toEqual(['stalled', 'stalled']));

        expect(reported).toHaveLength(1);
    });

    it('tells the surface when a stalled diff finally answers', async () => {
        const { watch } = createWatch();
        const outcomes: string[] = [];
        const diff = Promise.withResolvers<void>();

        watch.observe({
            waitForDiff: () => diff.promise,
            readModels: models,
            onOutcome: (outcome) => outcomes.push(outcome),
        });
        await vi.waitFor(() => expect(outcomes).toEqual(['stalled']));
        diff.resolve();

        await vi.waitFor(() => expect(outcomes).toEqual(['stalled', 'computed']));
    });

    it('stays silent toward a surface the user navigated away from', async () => {
        const { watch } = createWatch();
        const outcomes: string[] = [];
        const diff = Promise.withResolvers<void>();

        const cancel = watch.observe({
            waitForDiff: () => diff.promise,
            readModels: models,
            onOutcome: (outcome) => outcomes.push(outcome),
        });
        cancel();
        diff.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(outcomes).toEqual([]);
    });
});

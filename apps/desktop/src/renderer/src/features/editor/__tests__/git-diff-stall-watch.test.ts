import type { EditorWorkerStallDiagnostic } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerRoundTripResult } from '../../../lib/worker-round-trip';
import { GitDiffStallWatch } from '../git-diff-stall-watch';

function createWatch(
    overrides: {
        roundTrip?: WorkerRoundTripResult;
        minimumReportIntervalMs?: number;
        documentVisible?: boolean;
    } = {},
) {
    const reported: EditorWorkerStallDiagnostic[] = [];
    let identifier = 0;
    const watch = new GitDiffStallWatch({
        reportDiagnostic: (diagnostic) => reported.push(diagnostic),
        probeRoundTrip: () =>
            Promise.resolve(
                overrides.roundTrip ?? { outcome: 'no-reply' as const, durationMs: null },
            ),
        countEditorWorkers: () => 3,
        isDocumentVisible: () => overrides.documentVisible ?? false,
        now: () => Date.now(),
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
            workerRoundTrip: 'no-reply',
            workerRoundTripMs: null,
            documentVisible: false,
            originalLineCount: 12,
            modifiedLineCount: 15,
            identicalModels: false,
            diffOpenCount: 1,
            stallCount: 1,
            editorWorkersCreated: 3,
        });
        expect(reported[0]?.waitMs).toBeGreaterThanOrEqual(5);
    });

    it('records the recovery of a diff that arrives after its stall was reported', async () => {
        const { reported, watch } = createWatch();
        const diff = Promise.withResolvers<void>();

        watch.observe({ waitForDiff: () => diff.promise, readModels: models });
        await vi.waitFor(() => expect(reported).toHaveLength(1));
        diff.resolve();
        await vi.waitFor(() => expect(reported).toHaveLength(2));

        expect(reported[1]).toMatchObject({ outcome: 'recovered', workerRoundTrip: 'skipped' });
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
});

import { describe, expect, it } from 'vitest';

import { rendererDiagnosticSchema } from '../renderer-diagnostic.js';

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

describe('Renderer diagnostic contract', () => {
    it('accepts bounded content-free terminal renderer state', () => {
        expect(rendererDiagnosticSchema.parse(validDiagnostic)).toEqual(validDiagnostic);
    });

    it('accepts a bounded content-free Renderer resize burst', () => {
        expect(rendererDiagnosticSchema.parse(validResizeBurstDiagnostic)).toEqual(
            validResizeBurstDiagnostic,
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
});

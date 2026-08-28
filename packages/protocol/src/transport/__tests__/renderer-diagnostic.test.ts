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

describe('Renderer diagnostic contract', () => {
    it('accepts bounded content-free terminal renderer state', () => {
        expect(rendererDiagnosticSchema.parse(validDiagnostic)).toEqual(validDiagnostic);
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
});

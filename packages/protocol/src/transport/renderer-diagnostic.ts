import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';

export const RENDERER_DIAGNOSTIC_CHANNEL = 'caxri:renderer-diagnostic';

/**
 * Content-free Renderer state that is safe to persist in local diagnostics. The strict schema is the privacy boundary:
 * terminal output, prompts, source text, DOM labels, and arbitrary error messages cannot cross this IPC channel.
 */
export const terminalRendererDiagnosticSchema = z.strictObject({
    kind: z.literal('terminal-renderer'),
    diagnosticId: z.uuid(),
    terminalId: identifierSchema,
    mode: z.enum(['dom', 'webgl']),
    reason: z.enum([
        'active',
        'context-loss',
        'disabled',
        'disposed',
        'load-failed',
        'unsupported',
    ]),
    trigger: z.enum([
        'atlas-clear-failed',
        'dispose',
        'gpu-process-recovery',
        'preference-change',
        'visibility-restore',
        'webgl-context-loss',
        'webgl-load-failed',
    ]),
    preference: z.enum(['auto', 'off', 'on']),
    contextLossCount: z.number().int().nonnegative().max(10_000),
    redrawCount: z.number().int().nonnegative().max(1_000_000),
    correlationId: z.uuid().optional(),
    recoveryResult: z.enum(['not-requested', 'already-dom', 'dom-restored', 'failed']),
    receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    droppedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    paneActive: z.boolean(),
    terminalProcessRunning: z.boolean(),
    agentTerminal: z.boolean(),
    documentVisible: z.boolean(),
    documentFocused: z.boolean(),
    terminalFocused: z.boolean(),
});

const terminalGridColumnsSchema = z.number().int().min(2).max(1_000);
const terminalGridRowsSchema = z.number().int().min(1).max(1_000);
const resizeBurstCountSchema = z.number().int().nonnegative().max(10_000);

export const terminalResizeBurstDiagnosticSchema = z.strictObject({
    kind: z.literal('terminal-resize-burst'),
    diagnosticId: z.uuid(),
    terminalId: identifierSchema,
    side: z.literal('renderer-xterm'),
    sampleCount: z.number().int().positive().max(10_000),
    changeCount: resizeBurstCountSchema,
    startCols: terminalGridColumnsSchema,
    startRows: terminalGridRowsSchema,
    minCols: terminalGridColumnsSchema,
    minRows: terminalGridRowsSchema,
    maxCols: terminalGridColumnsSchema,
    maxRows: terminalGridRowsSchema,
    finalCols: terminalGridColumnsSchema,
    finalRows: terminalGridRowsSchema,
    durationMs: z.number().int().nonnegative().max(5_000),
    flushReason: z.enum(['disposed', 'max-duration', 'paused', 'quiet']),
    truncated: z.boolean(),
    localAppliedCount: resizeBurstCountSchema,
    requestCount: resizeBurstCountSchema,
});

function addAggregateIssue(context: z.core.$RefinementCtx<unknown>, path: string): void {
    context.addIssue({
        code: 'custom',
        message: 'Inconsistent resize burst aggregate',
        path: [path],
    });
}

export const rendererDiagnosticSchema = z
    .discriminatedUnion('kind', [
        terminalRendererDiagnosticSchema,
        terminalResizeBurstDiagnosticSchema,
    ])
    .superRefine((diagnostic, context) => {
        if (diagnostic.kind !== 'terminal-resize-burst') return;
        if (diagnostic.changeCount >= diagnostic.sampleCount)
            addAggregateIssue(context, 'changeCount');
        if (diagnostic.localAppliedCount > diagnostic.sampleCount)
            addAggregateIssue(context, 'localAppliedCount');
        if (diagnostic.requestCount > diagnostic.sampleCount)
            addAggregateIssue(context, 'requestCount');

        for (const dimension of ['Cols', 'Rows'] as const) {
            const minimum = diagnostic[`min${dimension}`];
            const maximum = diagnostic[`max${dimension}`];
            if (minimum > maximum) addAggregateIssue(context, `min${dimension}`);
            for (const position of ['start', 'final'] as const) {
                const value = diagnostic[`${position}${dimension}`];
                if (value < minimum || value > maximum)
                    addAggregateIssue(context, `${position}${dimension}`);
            }
        }
    });

export type TerminalRendererDiagnostic = z.infer<typeof terminalRendererDiagnosticSchema>;
export type TerminalResizeBurstDiagnostic = z.infer<typeof terminalResizeBurstDiagnosticSchema>;
export type RendererDiagnostic = z.infer<typeof rendererDiagnosticSchema>;

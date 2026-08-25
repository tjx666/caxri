import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';

export const RENDERER_DIAGNOSTIC_CHANNEL = 'caxri:renderer-diagnostic';

/**
 * Content-free Renderer state that is safe to persist in local diagnostics. The strict schema is the privacy boundary:
 * terminal output, prompts, source text, DOM labels, and arbitrary error messages cannot cross this IPC channel.
 */
export const rendererDiagnosticSchema = z
    .object({
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
            'preference-change',
            'visibility-restore',
            'webgl-context-loss',
            'webgl-load-failed',
        ]),
        preference: z.enum(['auto', 'off', 'on']),
        contextLossCount: z.number().int().nonnegative().max(10_000),
        redrawCount: z.number().int().nonnegative().max(1_000_000),
        paneActive: z.boolean(),
        terminalProcessRunning: z.boolean(),
        agentTerminal: z.boolean(),
        documentVisible: z.boolean(),
        documentFocused: z.boolean(),
        terminalFocused: z.boolean(),
    })
    .strict();

export type RendererDiagnostic = z.infer<typeof rendererDiagnosticSchema>;

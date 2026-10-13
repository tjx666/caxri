import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';
import { terminalRecordSchema } from './terminal-record.js';
import { terminalSurfaceSchema } from './terminal-surface.js';

const serverControl = commandPolicy('server', 'control');

/**
 * Methods that replace a Terminal's process while keeping the Terminal row, its tab, and its Agent Session.
 */
export const terminalRelaunchMethods = {
    'terminal.restart': {
        ...serverControl,
        params: z.object({
            terminalId: identifierSchema,
            mode: z.enum(['resume', 'fresh']).default('resume'),
        }),
        result: terminalRecordSchema,
    },
    /**
     * Reopens a bound Agent Terminal on the other surface (PTY or Chat) and resumes the same provider conversation
     * there (ADR 0012). A running turn is never ended silently: without `interruptTurn` the result is `turnRunning` and
     * nothing changed. An Agent Session that was never bound, or whose record was never written, is a `CONFLICT`.
     */
    'terminal.switchSurface': {
        ...serverControl,
        params: z.object({
            terminalId: identifierSchema,
            surface: terminalSurfaceSchema,
            interruptTurn: z.boolean().default(false),
        }),
        result: z.discriminatedUnion('status', [
            z.object({ status: z.literal('switched'), terminal: terminalRecordSchema }),
            z.object({ status: z.literal('turnRunning') }),
        ]),
    },
} as const satisfies Record<string, MethodSpec>;

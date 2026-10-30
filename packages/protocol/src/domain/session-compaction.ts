import { z } from 'zod';

import { identifierSchema } from './identifiers.js';

/**
 * Human-initiated batch results describe delivery, never claim that a provider finished compaction.
 */
const sessionCompactionOutcomeSchema = z.enum([
    'submitted',
    'unsupported',
    'not_running',
    'busy',
    'unsafe_input',
    'usage_unavailable',
    'already_compacted',
    'cache_expired',
    'changed',
    'failed',
    'delivery_unknown',
]);
export const sessionCompactionResultSchema = z.object({
    items: z
        .array(
            z.object({
                sessionId: identifierSchema,
                outcome: sessionCompactionOutcomeSchema,
            }),
        )
        .max(200),
    deferred: z.number().int().nonnegative(),
});
export type SessionCompactionOutcome = z.infer<typeof sessionCompactionOutcomeSchema>;
export type SessionCompactionResult = z.infer<typeof sessionCompactionResultSchema>;

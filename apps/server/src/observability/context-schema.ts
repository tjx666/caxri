import type { ObservationContext } from '@caxri/system';
import { z } from 'zod';

const observationIdSchema = z.string().regex(/^[A-Za-z0-9][\w.:-]{0,199}$/u);

/**
 * Private-wire schema for content-free correlation. Unknown keys and path/prose-shaped values fail closed.
 */
export const observationContextSchema: z.ZodType<ObservationContext> = z
    .object({
        agentRunId: observationIdSchema.optional(),
        bootId: observationIdSchema.optional(),
        buildId: observationIdSchema.optional(),
        clientId: observationIdSchema.optional(),
        connectionId: observationIdSchema.optional(),
        operationId: observationIdSchema.optional(),
        processId: z.number().int().positive().optional(),
        projectId: observationIdSchema.optional(),
        requestId: observationIdSchema.optional(),
        serverId: observationIdSchema.optional(),
        sessionId: observationIdSchema.optional(),
        terminalId: observationIdSchema.optional(),
        traceId: observationIdSchema.optional(),
    })
    .strict();

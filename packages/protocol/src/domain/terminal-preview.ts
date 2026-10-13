import { z } from 'zod';

import { identifierSchema } from './identifiers.js';

export const MAX_TERMINAL_PREVIEW_BYTES = 16 * 1024;

export const terminalPreviewSchema = z.strictObject({
    terminalId: identifierSchema,
    availability: z.enum(['live', 'stopped', 'unavailable']),
    content: z
        .string()
        .refine(
            (value) => new TextEncoder().encode(value).byteLength <= MAX_TERMINAL_PREVIEW_BYTES,
            `Terminal preview exceeds ${MAX_TERMINAL_PREVIEW_BYTES} UTF-8 bytes`,
        ),
    truncated: z.boolean(),
    updatedAt: z.number().int().positive(),
});

export type TerminalPreview = z.infer<typeof terminalPreviewSchema>;

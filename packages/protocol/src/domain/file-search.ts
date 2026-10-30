import { z } from 'zod';

import { pathSchema } from './identifiers.js';

export const fileSearchModeSchema = z.enum(['name', 'content']);

const fileSearchTerminationReasonSchema = z.enum([
    'completed',
    'canceled',
    'timeout',
    'file-limit',
    'result-limit',
    'payload-limit',
]);

const fileSearchMatchSchema = z.object({
    path: pathSchema,
    relativePath: z.string().min(1).max(16_384),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    matchLength: z.number().int().nonnegative().max(1_024).optional(),
    preview: z.string().max(500).optional(),
    previewMatchIndex: z.number().int().nonnegative().max(500).optional(),
});

export const fileSearchResultSchema = z
    .object({
        mode: fileSearchModeSchema,
        matches: z.array(fileSearchMatchSchema).max(500),
        scannedFiles: z.number().int().nonnegative(),
        truncated: z.boolean(),
        canceled: z.boolean(),
        terminationReason: fileSearchTerminationReasonSchema,
    })
    .superRefine((result, context) => {
        const isExpectedCanceled = result.terminationReason === 'canceled';
        const isExpectedTruncated = !['completed', 'canceled'].includes(result.terminationReason);
        if (result.canceled !== isExpectedCanceled)
            context.addIssue({
                code: 'custom',
                message: 'canceled must match the search termination reason',
                path: ['canceled'],
            });
        if (result.truncated !== isExpectedTruncated)
            context.addIssue({
                code: 'custom',
                message: 'truncated must match the search termination reason',
                path: ['truncated'],
            });
        if (result.canceled && result.matches.length > 0)
            context.addIssue({
                code: 'custom',
                message: 'A canceled search cannot expose partial matches',
                path: ['matches'],
            });
    });

export type FileSearchMode = z.infer<typeof fileSearchModeSchema>;
export type FileSearchMatch = z.infer<typeof fileSearchMatchSchema>;
export type FileSearchTerminationReason = z.infer<typeof fileSearchTerminationReasonSchema>;

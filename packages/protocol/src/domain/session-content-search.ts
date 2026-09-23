import { z } from 'zod';

import { agentProviderSchema, identifierSchema } from './domain.js';

export const sessionContentSearchParametersSchema = z.object({
    query: z.string().trim().min(1).max(200),
});

const sessionContentMatchSchema = z.object({
    sessionId: identifierSchema,
    provider: agentProviderSchema,
    snippet: z.string().max(320),
});

export const sessionContentSearchResultSchema = z.object({
    matches: z.array(sessionContentMatchSchema).max(100),
    scanned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    partial: z.boolean(),
    reason: z.enum(['complete', 'coverage', 'budget', 'results']),
});

export type SessionContentSearchResult = z.infer<typeof sessionContentSearchResultSchema>;

import { z } from 'zod';

import { identifierSchema, pathSchema } from './domain.js';

/**
 * Safe display metadata for one authorized Terminal file-link candidate. The absolute path remains subject to Server
 * revalidation when selected; the Renderer uses only the relative path and Project title for disambiguation.
 */
export const terminalFileLinkCandidateSchema = z.object({
    path: pathSchema,
    relativePath: z.string().min(1).max(16_384),
    projectId: identifierSchema,
    projectTitle: z.string().min(1).max(512),
});

export const terminalFileLinkAmbiguousResultSchema = z.object({
    status: z.literal('ambiguous'),
    candidates: z.array(terminalFileLinkCandidateSchema).min(1).max(50),
    truncated: z.boolean(),
});

export const terminalFileLinkAmbiguousResolutionSchema =
    terminalFileLinkAmbiguousResultSchema.extend({ sourceSessionId: identifierSchema });

export type TerminalFileLinkCandidate = z.infer<typeof terminalFileLinkCandidateSchema>;

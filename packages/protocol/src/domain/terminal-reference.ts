import { z } from 'zod';

import { identifierSchema } from './domain.js';

export const terminalGitHubRepoSchema = z.strictObject({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
});

export const terminalReferenceContextSchema = z.strictObject({
    githubRepositories: z.array(terminalGitHubRepoSchema).max(50),
});

export const terminalCommitLinkCandidateSchema = z.strictObject({
    repositoryId: identifierSchema,
    repositoryName: z.string().min(1).max(1_024),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export const terminalCommitLinkResolutionSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('resolved'),
        candidate: terminalCommitLinkCandidateSchema,
    }),
    z.strictObject({
        status: z.literal('ambiguous'),
        candidates: z.array(terminalCommitLinkCandidateSchema).min(2).max(50),
    }),
]);

export type TerminalReferenceContext = z.infer<typeof terminalReferenceContextSchema>;
export type TerminalCommitLinkCandidate = z.infer<typeof terminalCommitLinkCandidateSchema>;
export type TerminalCommitLinkResolution = z.infer<typeof terminalCommitLinkResolutionSchema>;

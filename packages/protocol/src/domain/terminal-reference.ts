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

/**
 * What the Renderer hovered, in the only two shapes worth asking the Server about.
 *
 * A reference matched by a configured rule (a Linear ticket, an internal tracker) is deliberately absent: the card for
 * one is built entirely from the rule the user already configured, so it costs no request and no subprocess.
 */
export const terminalReferencePreviewRequestSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('commit'),
        /**
         * Abbreviated exactly as it appeared on screen; the Server resolves it against the Session's repositories.
         */
        reference: z.string().regex(/^[0-9a-f]{7,40}$/i),
    }),
    z.strictObject({
        kind: z.literal('github'),
        owner: z.string().min(1).max(100),
        repo: z.string().min(1).max(100),
        number: z.number().int().positive().max(10_000_000),
    }),
]);

/**
 * Why a preview has nothing to show. A closed enum rather than a message so the outcome stays countable: "the CLI is
 * missing" and "GitHub is rate limited" are the same blank card to the user and completely different problems to the
 * operator.
 */
export const terminalReferencePreviewUnavailableReasonSchema = z.enum([
    'ambiguous',
    'cli-missing',
    'failed',
    'not-authenticated',
    'not-found',
    'rate-limited',
]);

export const terminalReferencePreviewSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('commit'),
        author: z.string().max(1_024),
        authoredAt: z.number().int().nonnegative(),
        /**
         * Message below the subject, already truncated for a card; empty for a single-line message.
         */
        body: z.string().max(2_048),
        changedFileCount: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        insertions: z.number().int().nonnegative(),
        repositoryName: z.string().min(1).max(1_024),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        shortSha: z.string().min(7).max(12),
        subject: z.string().max(1_024),
    }),
    z.strictObject({
        kind: z.literal('github'),
        author: z.string().max(1_024),
        createdAt: z.number().int().nonnegative(),
        isDraft: z.boolean(),
        /**
         * A merged pull request; GitHub reports it as `closed` in `state`.
         */
        isMerged: z.boolean(),
        isPullRequest: z.boolean(),
        number: z.number().int().positive(),
        state: z.string().min(1).max(64),
        title: z.string().max(1_024),
        url: z.string().max(2_048),
    }),
    z.strictObject({
        kind: z.literal('unavailable'),
        reason: terminalReferencePreviewUnavailableReasonSchema,
    }),
]);

export type TerminalReferenceContext = z.infer<typeof terminalReferenceContextSchema>;
export type TerminalCommitLinkCandidate = z.infer<typeof terminalCommitLinkCandidateSchema>;
export type TerminalCommitLinkResolution = z.infer<typeof terminalCommitLinkResolutionSchema>;
export type TerminalReferencePreviewRequest = z.infer<typeof terminalReferencePreviewRequestSchema>;
export type TerminalReferencePreview = z.infer<typeof terminalReferencePreviewSchema>;
export type TerminalReferencePreviewUnavailableReason = z.infer<
    typeof terminalReferencePreviewUnavailableReasonSchema
>;

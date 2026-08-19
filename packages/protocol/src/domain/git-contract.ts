import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    canceledResultSchema,
    gitBlameSchema,
    gitBranchSchema,
    gitCommitDetailsSchema,
    gitCommitPageSchema,
    gitCommitSchema,
    gitDiffDocumentSchema,
    gitOverviewSchema,
    gitPullRequestChangesSchema,
    gitSummarySchema,
    identifierSchema,
    pathSchema,
} from './domain.js';

const hostRead = commandPolicy('host', 'read');
const hostWrite = commandPolicy('host', 'write');
const desktopWrite = commandPolicy('desktop', 'write');

const gitDiscardScopeSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('all'),
        /**
         * Changed-file count shown in the confirmation copy.
         */
        fileCount: z.number().int().positive().max(100_000),
    }),
    z.object({
        kind: z.literal('file'),
        path: pathSchema,
        /**
         * Untracked files are deleted rather than restored, so the prompt must say so.
         */
        untracked: z.boolean(),
    }),
]);

/**
 * Every public `git.*` command. Read projections stay Host-owned; the two working-tree mutations differ by confirmation
 * ownership: `git.sync` runs without a prompt, while `git.discard` is Desktop-owned because the irreversible
 * working-tree wipe must pass through Main's native confirmation dialog before it reaches Runtime.
 */
export const gitMethods = {
    'git.summary': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            /**
             * Monotonic user-refresh nonce. A changed value forces the producer to request the newest repository
             * generation instead of joining a cached snapshot.
             */
            refresh: z.number().int().nonnegative().default(0),
        }),
        result: gitSummarySchema,
    },
    'git.overview': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema }),
        result: gitOverviewSchema,
    },
    'git.branches': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        result: z.array(gitBranchSchema).max(1_000),
    },
    'git.switchBranch': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            branch: z.string().min(1).max(1_024),
        }),
        result: z.null(),
    },
    'git.sync': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        result: z.null(),
    },
    'git.discard': {
        ...desktopWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            /**
             * Display name for the native confirmation copy only; Runtime re-derives every discarded path from its own
             * status snapshot, never from these display fields.
             */
            repositoryName: z.string().min(1).max(1_024),
            scope: gitDiscardScopeSchema,
        }),
        result: z.union([canceledResultSchema, z.null()]),
    },
    'git.diffDocument': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.pullRequestChanges': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            refresh: z.number().int().nonnegative().default(0),
        }),
        result: gitPullRequestChangesSchema.nullable(),
    },
    'git.pullRequestDiffDocument': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.commits': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            offset: z.number().int().nonnegative().max(10_000).default(0),
            pageSize: z.number().int().min(1).max(50).default(25),
            path: pathSchema.optional(),
        }),
        result: gitCommitPageSchema,
    },
    'git.commitDetails': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema.optional(),
        }),
        result: gitCommitDetailsSchema,
    },
    'git.commitDiffDocument': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.blame': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            line: z.number().int().positive().max(10_000_000),
        }),
        result: gitBlameSchema.nullable(),
    },
    'git.fileHead': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
        }),
        result: gitCommitSchema.nullable(),
    },
} as const satisfies Record<string, MethodSpec>;

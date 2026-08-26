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
const hostControl = commandPolicy('host', 'control');
const desktopWrite = commandPolicy('desktop', 'write');

const gitDiscardScopeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({
        kind: z.literal('file'),
        path: pathSchema,
    }),
]);

const gitDiscardPreflightScopeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('file'), path: pathSchema }),
]);

const gitDiscardConsentScopeSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('all'),
        fileCount: z.number().int().positive().max(100_000),
    }),
    z.object({
        kind: z.literal('file'),
        path: pathSchema,
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
    'git.remoteHost': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        /**
         * Lower-cased `origin` remote host, or `null` when the remote is missing or unparseable. Gates whether the Git
         * panel's commit avatars may resolve through GitHub (see `extensions/git/src/github-avatar.ts`); this command
         * never sends anything to the remote itself, it only reads local Git config.
         */
        result: z.string().nullable(),
    },
    'git.discard': {
        ...desktopWrite,
        params: z.strictObject({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            /**
             * Runtime derives confirmation copy, counts, and tracked state from its authorized status snapshot.
             */
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

/**
 * Runtime-owned destructive Git confirmation. The preflight response is the only data allowed to reach the native
 * confirmation prompt; the opaque token binds that copy to the full Runtime status fingerprint and is consumed once by
 * the apply method. These methods are internal so extension and Renderer callers cannot forge a consent payload.
 */
export const gitInternalMethods = {
    'git.discard.preflight': {
        ...hostControl,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            scope: gitDiscardPreflightScopeSchema,
        }),
        result: z.union([
            z.object({ status: z.literal('noop') }),
            z.object({
                status: z.literal('ready'),
                token: identifierSchema,
                repositoryName: z.string().min(1).max(1_024),
                scope: gitDiscardConsentScopeSchema,
            }),
        ]),
    },
    'git.discard.apply': {
        ...hostControl,
        params: z.object({ token: identifierSchema }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

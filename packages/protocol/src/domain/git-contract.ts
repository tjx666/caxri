import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    canceledResultSchema,
    gitBlameSchema,
    gitBranchSchema,
    gitCommitDetailsSchema,
    gitCommitPageSchema,
    gitDiffDocumentSchema,
    gitFileHeadSchema,
    gitOverviewSchema,
    gitPullRequestChangesSchema,
    gitSummarySchema,
    gitSummaryWireRequesterSchema,
    identifierSchema,
    pathSchema,
} from './domain.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const serverControl = commandPolicy('server', 'control');
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
 * Every public `git.*` command. Read projections stay Server-owned; the two working-tree mutations differ by
 * confirmation ownership: `git.sync` runs without a prompt, while `git.discard` is Desktop-owned because the
 * irreversible working-tree wipe must pass through Main's native confirmation dialog before it reaches Runtime.
 */
export const gitMethods = {
    'git.summary': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            /**
             * Monotonic user-refresh nonce. A changed value forces the producer to request the newest repository
             * generation instead of joining a cached snapshot.
             */
            refresh: z.number().int().nonnegative().default(0),
            requester: gitSummaryWireRequesterSchema.default('renderer'),
        }),
        result: gitSummarySchema,
    },
    'git.overview': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            /**
             * Re-read working-tree status instead of joining the cached snapshot. Only the selected Session's Workbench
             * Root is file-watched, so a plain edit elsewhere never advances that root's snapshot on its own; a reader
             * of another Session's count asks for a fresh one (issue #859).
             */
            refresh: z.boolean().default(false),
        }),
        result: gitOverviewSchema,
    },
    'git.branches': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        result: z.array(gitBranchSchema).max(1_000),
    },
    'git.switchBranch': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            branch: z.string().min(1).max(1_024),
        }),
        result: z.null(),
    },
    'git.sync': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        result: z.null(),
    },
    /**
     * Merges the repository's GitHub pull request through `gh pr merge`, using the first merge method the repository
     * allows in the order squash, merge commit, rebase. `headSha` is the head the user saw when they chose to merge; it
     * is passed as `--match-head-commit`, so a push that lands after that moment makes GitHub reject the merge instead
     * of merging commits nobody looked at. Branch deletion is left to the repository's own setting.
     */
    'git.mergePullRequest': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            number: z.number().int().positive(),
            headSha: z.string().regex(/^[0-9a-f]{40}$/),
        }),
        /**
         * `url` is the merged pull request's GitHub page.
         */
        result: z.object({ method: z.enum(['squash', 'merge', 'rebase']), url: z.url() }),
    },
    'git.remoteHost': {
        ...serverRead,
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
             * The Git domain derives confirmation copy, counts, and tracked state from its authorized status snapshot.
             */
            scope: gitDiscardScopeSchema,
        }),
        result: z.union([canceledResultSchema, z.null()]),
    },
    'git.diffDocument': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        /**
         * A discarded or committed working change has no remaining diff.
         */
        result: gitDiffDocumentSchema.nullable(),
    },
    'git.pullRequestChanges': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            refresh: z.number().int().nonnegative().default(0),
        }),
        result: gitPullRequestChangesSchema.nullable(),
    },
    'git.pullRequestDiffDocument': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.commits': {
        ...serverRead,
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
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema.optional(),
        }),
        result: gitCommitDetailsSchema,
    },
    'git.commitDiffDocument': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.blame': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            line: z.number().int().positive().max(10_000_000),
        }),
        result: gitBlameSchema.nullable(),
    },
    'git.fileHead': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
        }),
        result: gitFileHeadSchema
            .extend({ repositoryId: identifierSchema, path: pathSchema })
            .nullable(),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Runtime-owned destructive Git confirmation. The preflight response is the only data allowed to reach the native
 * confirmation prompt; the opaque token binds that copy to the full Runtime status fingerprint and is consumed once by
 * the apply method. These methods are internal so extension and Renderer callers cannot forge a consent payload.
 */
export const gitInternalMethods = {
    'git.discard.preflight': {
        ...serverControl,
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
        ...serverControl,
        params: z.object({ token: identifierSchema }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

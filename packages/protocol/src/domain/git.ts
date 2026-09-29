import { z } from 'zod';

/**
 * One changed file's line counts, present when the producer measured them and always together. Binary files count as
 * zero; a new file past the producer's counting cap omits both.
 */
export const gitFileLineStatsShape = {
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
};

const gitFileStatusSchema = z.object({
    path: z.string(),
    originalPath: z.string().optional(),
    index: z.string(),
    workingTree: z.string(),
    kind: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
    ...gitFileLineStatsShape,
});

/**
 * Safe transport bound for one repository's working-tree status projection. A larger change set is truncated at the
 * producer; `changedFileCount` still reports the full size so consumers can render an explicit "Showing the first N
 * changes" state instead of silently dropping entries.
 */
export const MAX_GIT_STATUS_FILES = 2_000;

const gitDetachedHeadSchema = z.object({
    /**
     * Subject line of the checked-out commit.
     */
    subject: z.string().min(1).max(1_024),
    /**
     * A tag, else a remote branch (`origin/main`), whose tip is exactly this commit.
     */
    reference: z.string().min(1).max(1_024).optional(),
});

const gitRepoSummarySchema = z.object({
    id: z.string(),
    kind: z.enum(['primary', 'worktree', 'nested', 'submodule']),
    name: z.string(),
    rootPath: z.string(),
    branch: z.string(),
    // Full 40-hex HEAD oid: the Git panel's commit mode feeds it straight into
    // `git.commitDetails`, whose sha param enforces the same shape.
    head: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
    /**
     * Tracked remote branch; absent for an unpublished branch and for a detached HEAD.
     */
    upstream: z.string().min(1).max(1_024).optional(),
    /**
     * Human-readable identity of a detached HEAD; present only when `branch` is `(detached)`.
     */
    detachedHead: gitDetachedHeadSchema.optional(),
    ahead: z.number(),
    behind: z.number(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    /**
     * Monotonic status snapshot generation. Every consumer of the same repository generation observes the same
     * canonical snapshot, so cross-view numbers can never disagree.
     */
    generation: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    files: z.array(gitFileStatusSchema).max(MAX_GIT_STATUS_FILES),
});

/**
 * Count/branch projection for consumers such as the Status Bar that must never pull the full working-tree `files[]`
 * payload across IPC.
 */
const gitRepoOverviewSchema = gitRepoSummarySchema.omit({ files: true });

export const gitOverviewSchema = z.object({
    isRepository: z.boolean(),
    repositories: z.array(gitRepoOverviewSchema),
    error: z.string().optional(),
});

export const gitPullRequestChangesSchema = z.object({
    repositoryId: z.string(),
    number: z.number().int().positive(),
    title: z.string().max(4_096),
    url: z.url(),
    baseRefName: z.string().min(1).max(1_024),
    headRefName: z.string().min(1).max(1_024),
    baseOid: z.string().regex(/^[0-9a-f]{40}$/),
    headOid: z.string().regex(/^[0-9a-f]{40}$/),
    unpushedCommitCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(gitFileStatusSchema).max(2_000),
});

// Exported so `domain.ts` can compose `gitCommitDetailsSchema` without duplicating this schema.
export const gitCommitSchema = z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    shortSha: z.string().min(7).max(12),
    subject: z.string().max(4_096),
    /**
     * Full commit message body below the subject; empty for single-line messages.
     */
    body: z.string().max(16_384),
    author: z.string().max(1_024),
    authorEmail: z.string().max(1_024),
    authoredAt: z.number().int().nonnegative(),
    decorations: z.array(z.string().max(1_024)).max(50),
    parents: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(64),
});

/**
 * Latest commit touching an Editor file together with the repository identity needed to open that commit's file diff.
 * `path` is the repository-relative path in local HEAD, which can differ from the open working-tree path during an
 * uncommitted rename; the caller's Session-scoped path never becomes an authority token of its own.
 */
export const gitFileHeadSchema = gitCommitSchema.extend({
    repositoryId: z.string(),
    path: z.string(),
});

export const gitCommitPageSchema = z.object({
    commits: z.array(gitCommitSchema).max(50),
    nextOffset: z.number().int().nonnegative().optional(),
});

export const gitBlameSchema = z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    author: z.string().min(1).max(1_024),
    authoredAt: z.number().int().nonnegative(),
    subject: z.string().max(4_096),
    line: z.number().int().positive(),
    uncommitted: z.boolean(),
});

/**
 * Which client boundary asked for a Git summary. The Renderer never sends this field (the default applies), while the
 * Server-owned Extension Host bridge stamps `extension` so `git.summary` logs can attribute refresh volume to its entry
 * point instead of inferring it from context fields.
 */
export const gitSummaryWireRequesterSchema = z.enum(['renderer', 'extension']);
export type GitSummaryWireRequester = z.infer<typeof gitSummaryWireRequesterSchema>;

export const gitSummarySchema = z.object({
    isRepository: z.boolean(),
    repositories: z.array(gitRepoSummarySchema),
    error: z.string().optional(),
});

export const gitBranchSchema = z.object({
    name: z.string().min(1).max(1_024),
    /**
     * Epoch milliseconds of the branch tip commit's committer date.
     */
    committedAt: z.number().int().nonnegative(),
});

export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;
export type GitDetachedHead = z.infer<typeof gitDetachedHeadSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported widely across apps/desktop and apps/server/src/domains, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type GitRepositorySummary = z.infer<typeof gitRepoSummarySchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported widely across apps/desktop and apps/server/src/domains, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type GitRepositoryOverview = z.infer<typeof gitRepoOverviewSchema>;
export type GitSummary = z.infer<typeof gitSummarySchema>;
export type GitOverview = z.infer<typeof gitOverviewSchema>;
export type GitPullRequestChanges = z.infer<typeof gitPullRequestChangesSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitFileHead = z.infer<typeof gitFileHeadSchema>;
export type GitCommitPage = z.infer<typeof gitCommitPageSchema>;
export type GitBlame = z.infer<typeof gitBlameSchema>;

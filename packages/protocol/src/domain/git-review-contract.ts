import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const serverControl = commandPolicy('server', 'control');

/**
 * `comment.path` is repository-relative (matches `GitDiffDocument.path`/`originalPath`), never the canonical absolute
 * form `pathSchema` validates, so it gets its own bounded string schema instead of reusing that one.
 */
const gitReviewRepoRelativePathSchema = z.string().min(1).max(4_096);
const gitReviewSourceKeySchema = z.string().min(1).max(512);

export const gitReviewCommentSideSchema = z.enum(['original', 'modified']);
export const gitReviewCommentStatusSchema = z.enum(['pending', 'sent', 'outdated']);

/**
 * One anchored review note on a Git diff. Held in a Server-owned in-memory store scoped by Session + repository (see
 * `docs/git-diff-review.md`) instead of the Desktop Renderer, so a future mobile client reading through the gateway
 * shares the same data instead of needing its own copy of this state.
 */
export const gitReviewCommentSchema = z.object({
    id: identifierSchema,
    sessionId: identifierSchema,
    repositoryId: identifierSchema,
    sourceKey: gitReviewSourceKeySchema,
    path: gitReviewRepoRelativePathSchema,
    side: gitReviewCommentSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    snippet: z.string().max(200_000),
    text: z.string().max(20_000),
    status: gitReviewCommentStatusSchema,
});

export type GitReviewComment = z.infer<typeof gitReviewCommentSchema>;

export const gitReviewPendingGroupSchema = z.object({
    sessionId: identifierSchema,
    repositoryId: identifierSchema,
    repositoryName: z.string(),
    count: z.number().int().nonnegative(),
});

/**
 * Every repository with at least one pending comment, in one read: the quit guard and the "show pending review
 * comments" command both need the whole app's count without knowing which Session or repository to ask about first.
 */
export const gitReviewPendingSummarySchema = z.object({
    count: z.number().int().nonnegative(),
    groups: z.array(gitReviewPendingGroupSchema).max(1_000),
});

export type GitReviewPendingGroup = z.infer<typeof gitReviewPendingGroupSchema>;
export type GitReviewPendingSummary = z.infer<typeof gitReviewPendingSummarySchema>;

export const gitReviewSendResultSchema = z.object({
    sentCommentIds: z.array(identifierSchema).max(1_000),
});

export type GitReviewSendResult = z.infer<typeof gitReviewSendResultSchema>;

/**
 * True at or below the local long-paste threshold this feature has always used for its own single-message check,
 * independent of the user's configurable `terminal.longPasteThreshold` setting that gates the separate Terminal paste
 * route.
 */
const REVIEW_PROMPT_INLINE_CHARACTER_LIMIT = 4_000;

export function isGitReviewPromptInline(prompt: string): boolean {
    return prompt.length <= REVIEW_PROMPT_INLINE_CHARACTER_LIMIT;
}

export function reviewSnippet(content: string, startLine: number, endLine: number): string {
    return content
        .split('\n')
        .slice(startLine - 1, endLine)
        .join('\n');
}

/**
 * Submit a multiline review as one bracketed paste, matching xterm's Agent paste path.
 */
export function formatReviewTerminalInput(text: string): string {
    return `\u{1B}[200~${text.replaceAll('\n', '\r')}\u{1B}[201~\r`;
}

/**
 * Duplicated from the Desktop Renderer's `lib/file-path.ts` (`projectRelativePath`) and `features/editor/file-
 * reference.ts` (`formatFileReference`) rather than imported: this module is shared by the Server, which may not import
 * Renderer code, and the reference text must stay byte-identical to what other file-reference commands already send.
 * Keep both copies in sync if the mention format changes.
 */
function reviewFileReference(
    path: string,
    projectRoot: string | undefined,
    startLine: number,
    endLine: number,
): string {
    const isAtOrBelow = (candidate: string, parent: string): boolean =>
        candidate === parent ||
        (parent === '/' ? candidate.startsWith('/') : candidate.startsWith(`${parent}/`));
    const relativePath =
        projectRoot && isAtOrBelow(path, projectRoot)
            ? projectRoot === '/'
                ? path.slice(1)
                : path === projectRoot
                  ? '.'
                  : path.slice(projectRoot.length + 1)
            : undefined;
    const target = relativePath && relativePath !== '.' ? relativePath : path;
    const range = endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
    return `@${target}${range} `;
}

/**
 * What one review comment says, wherever it was written: a Git diff (`gitReview.*`) or an Agent Chat turn's changes.
 */
export interface ReviewCommentText {
    /**
     * The commented file's absolute path; it is cited relative to the Project root when inside it.
     */
    path: string;
    side: GitReviewComment['side'];
    startLine: number;
    endLine: number;
    snippet: string;
    text: string;
}

/**
 * A fence longer than any backtick run in `snippet`, so a snippet that itself contains a code fence cannot close it.
 */
function snippetFence(snippet: string): string {
    const longest = Math.max(0, ...(snippet.match(/`+/gu) ?? []).map((run) => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * One review comment as the Agent reads it: the cited lines with where they came from, the snippet fenced, then the
 * comment. Git diff reviews and Agent Chat turn reviews share it so both read the same to the Agent.
 */
export function formatReviewComment(
    comment: ReviewCommentText,
    projectRoot: string | undefined,
    source: string,
    fenceLanguage = '',
): string {
    const fence = snippetFence(comment.snippet);
    return [
        `${reviewFileReference(comment.path, projectRoot, comment.startLine, comment.endLine).trim()} (${source}, ${comment.side} side)`,
        `${fence}${fenceLanguage}`,
        comment.snippet,
        fence,
        comment.text,
    ].join('\n');
}

/**
 * The one prompt sent to the Agent for a batch of review comments. Shared by the Desktop Renderer, which renders it as
 * the send dialog's preview, and the Server, which sends the identical text it independently reconstructs from its own
 * comment store, so the two never have to agree over IPC about what the prompt looks like.
 */
export function formatGitReviewComments(
    comments: readonly GitReviewComment[],
    projectRoot: string | undefined,
    resolvePath: (comment: GitReviewComment) => string,
): string {
    return [
        'Please address each Git diff review comment below. Check the current file contents before editing because line numbers may have changed.',
        '',
        ...comments.flatMap((comment, index) => [
            `${index + 1}. ${formatReviewComment({ ...comment, path: resolvePath(comment) }, projectRoot, comment.sourceKey)}`,
            '',
        ]),
    ]
        .join('\n')
        .trimEnd();
}

/**
 * Every public `gitReview.*` command. Reads and mutations are Server-owned so a future mobile client reaches the same
 * store through the gateway instead of needing its own; `gitReview.send` performs the Terminal write on the Server too,
 * for the same reason. See `docs/git-diff-review.md` for the storage scope and its restart limitation.
 */
export const gitReviewMethods = {
    'gitReview.list': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, repositoryId: identifierSchema }),
        result: z.array(gitReviewCommentSchema).max(10_000),
    },
    /**
     * Every repository with a pending comment, across every Session, in one read: the app-quit reminder and the "Show
     * Pending Review Comments" command both need this without already knowing where to look.
     */
    'gitReview.pending': {
        ...serverRead,
        params: z.object({}).default({}),
        result: gitReviewPendingSummarySchema,
    },
    'gitReview.add': {
        ...serverWrite,
        params: z.object({
            id: identifierSchema,
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sourceKey: gitReviewSourceKeySchema,
            path: gitReviewRepoRelativePathSchema,
            side: gitReviewCommentSideSchema,
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            snippet: z.string().max(200_000),
        }),
        result: gitReviewCommentSchema,
    },
    /**
     * Editing a sent or outdated comment's text returns it to `pending`, or a correction would silently never reach the
     * Agent: resetting is a no-op for an already-pending comment and otherwise clears the resolved status the stale
     * text earned.
     */
    'gitReview.edit': {
        ...serverWrite,
        params: z.object({ id: identifierSchema, text: z.string().max(20_000) }),
        result: gitReviewCommentSchema,
    },
    'gitReview.remove': {
        ...serverWrite,
        params: z.object({ id: identifierSchema }),
        result: z.null(),
    },
    /**
     * Recomputes outdated status for one file/side after its diff content refreshed. A changed anchor is invalidated
     * instead of migrating silently to an unrelated line.
     */
    'gitReview.refresh': {
        ...serverControl,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sourceKey: gitReviewSourceKeySchema,
            path: gitReviewRepoRelativePathSchema,
            side: gitReviewCommentSideSchema,
            content: z.string().max(50_000_000),
        }),
        result: z.null(),
    },
    'gitReview.clearResolved': {
        ...serverWrite,
        params: z.object({ sessionId: identifierSchema, repositoryId: identifierSchema }),
        result: z.null(),
    },
    /**
     * Builds the prompt from the Server's own comment store, writes it to the already-attached Terminal the Renderer
     * selected and identifies here, and marks the sent comments. The Renderer still owns Terminal selection,
     * activation, and the attachment wait: those depend on `PaneLayout`, a Renderer-only concept the Server has no view
     * of.
     */
    'gitReview.send': {
        ...serverControl,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: gitReviewSendResultSchema,
    },
} as const;

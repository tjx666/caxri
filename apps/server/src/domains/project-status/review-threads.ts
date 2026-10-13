import type {
    ProjectStatusCodexReview,
    ProjectStatusRepository,
    ProjectStatusReviewThread,
} from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import type { ExternalStatusCommandTelemetry, ExternalStatusRunner } from '../external-status';
import { parseExternalJson } from '../external-status';
import { SingleFlight } from '../single-flight';
import { parseCodexReviewSummary } from './codex-review-summary';

type PullRequest = ProjectStatusRepository['pullRequest'];

/**
 * Matches the pull-request store's TTL (`external-status/github.ts`), so an automatic Status refresh that reuses the
 * shared PR record also reuses its review threads instead of spending a GraphQL query on them every round.
 */
const RECORD_TTL_MS = 90_000;
const MAX_RECORDS = 128;
/**
 * The same page size vscode-fe-helper's sidebar reads. A pull request with more unresolved threads than this already
 * needs the GitHub page, and a second page would double the query cost for rows nobody scrolls to.
 */
const THREAD_PAGE_SIZE = 50;
/**
 * Codex posts its review summary comment when the pull request opens and edits it afterwards, so it sits among the
 * conversation's first comments. GraphQL cannot filter comments by author or body, and reading the whole conversation
 * would pay for every bot's deployment comment on a busy pull request.
 */
const COMMENT_PAGE_SIZE = 30;

/**
 * A thread's `comments(first: 1)` is its opening comment: the one that states what needs addressing. The pull request's
 * own `comments` are the conversation, read for Codex's review summary.
 *
 * @see https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread
 */
const REVIEW_THREADS_QUERY = `query ReviewThreads($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:${THREAD_PAGE_SIZE}){nodes{isResolved isOutdated path line comments(first:1){nodes{body url createdAt author{login}}}}} comments(first:${COMMENT_PAGE_SIZE}){nodes{body url}}}}}`;

const commentSchema = z.object({
    body: z.string().nullish(),
    url: z.url().nullish(),
    createdAt: z.string().nullish(),
    author: z.object({ login: z.string().nullish() }).nullish(),
});

const threadSchema = z.object({
    isResolved: z.boolean().optional(),
    isOutdated: z.boolean().optional(),
    path: z.string().nullish(),
    line: z.number().int().nullish(),
    comments: z.object({ nodes: z.array(commentSchema) }),
});

const threadsSchema = z.object({ nodes: z.array(threadSchema.nullable()) });
const conversationCommentSchema = z.object({ body: z.string().nullish(), url: z.url().nullish() });
const conversationSchema = z.object({ nodes: z.array(conversationCommentSchema.nullable()) });
const pullRequestSchema = z.object({
    reviewThreads: threadsSchema,
    comments: conversationSchema.nullish(),
});
const repoSchema = z.object({ pullRequest: pullRequestSchema.nullable() });

const responseSchema = z.object({
    data: z.object({ repository: repoSchema.nullable() }),
});

/**
 * What a pull request's review left behind: its unresolved threads, how many threads it has in total, and Codex's
 * review summary rows.
 */
export interface ReviewFeedback {
    threads: ProjectStatusReviewThread[];
    threadCount: number;
    codexReviews: ProjectStatusCodexReview[];
}

/**
 * Throws a `VALIDATION` error on malformed output so the command telemetry records it; a repository or pull request
 * GitHub no longer returns is empty feedback rather than an error.
 */
export function parseReviewFeedback(output: string): ReviewFeedback {
    const response = parseExternalJson(output, responseSchema, 'GitHub review threads');
    const pullRequest = response.data.repository?.pullRequest;
    const nodes = pullRequest?.reviewThreads.nodes ?? [];
    const threads: ProjectStatusReviewThread[] = [];
    for (const thread of nodes) {
        if (!thread || thread.isResolved || thread.isOutdated) continue;
        const comment = thread.comments.nodes.at(0);
        if (!comment?.url) continue;
        const createdAt = comment.createdAt ? Date.parse(comment.createdAt) : NaN;
        threads.push({
            url: comment.url,
            body: comment.body ?? '',
            ...(comment.author?.login && { author: comment.author.login }),
            ...(Number.isFinite(createdAt) && { createdAt }),
            ...(thread.path && { path: thread.path }),
            ...(thread.line && thread.line > 0 && { line: thread.line }),
        });
    }
    // Codex keeps one summary comment and edits it in place; the last one wins if a pull request somehow has several.
    const summary = (pullRequest?.comments?.nodes ?? [])
        .map((comment) =>
            comment?.body && comment.url ? parseCodexReviewSummary(comment.body, comment.url) : [],
        )
        .findLast((reviews) => reviews.length > 0);
    return {
        threads,
        threadCount: nodes.filter((thread) => thread !== null).length,
        codexReviews: summary ?? [],
    };
}

interface StoredRecord {
    fetchedAt: number;
    feedback: ReviewFeedback;
}

/**
 * Review feedback per pull request (unresolved threads and Codex's review summary), for the Status panel.
 *
 * Separate from the shared pull-request store because `gh pr view --json` cannot return review threads: only GraphQL
 * exposes `isResolved`, and folding a hand-written GraphQL query into that store would change what the status bar, the
 * sidebar sweep, and Source Control pay for a field only the Status panel renders. A failed read is never cached: the
 * pull request goes out without threads for that round, and the next refresh asks again.
 */
export class ReviewThreadStore {
    private readonly records = new Map<string, StoredRecord>();
    private readonly requests = new SingleFlight<string, ReviewFeedback>();

    constructor(
        private readonly telemetry: Pick<
            ExternalStatusCommandTelemetry,
            'observe' | 'recordParseFailure'
        >,
        private readonly runner: ExternalStatusRunner,
        private readonly options: { now?: () => number; ttlMs?: number } = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async feedback(
        cwd: string,
        slug: { owner: string; repo: string; number: number },
        maxAgeMs: number | undefined,
    ): Promise<ReviewFeedback> {
        const key = `${slug.owner}/${slug.repo}#${slug.number}`;
        const cached = this.records.get(key);
        const ttl = maxAgeMs ?? this.options.ttlMs ?? RECORD_TTL_MS;
        if (cached && this.now() - cached.fetchedAt < ttl) return cached.feedback;
        return this.requests.run(key, async () => {
            const arguments_ = [
                'api',
                'graphql',
                '--hostname',
                'github.com',
                '--raw-field',
                `query=${REVIEW_THREADS_QUERY}`,
                '--raw-field',
                `owner=${slug.owner}`,
                '--raw-field',
                `name=${slug.repo}`,
                // `--field` (not `--raw-field`) so `gh` sends the number as the `Int!` the query declares.
                '--field',
                `number=${slug.number}`,
            ];
            const output = await this.telemetry.observe({
                command: 'gh',
                arguments: arguments_,
                run: () => this.runner('gh', arguments_, cwd),
            });
            const feedback = parseReviewFeedback(output);
            rememberBounded(this.records, key, { fetchedAt: this.now(), feedback }, MAX_RECORDS);
            return feedback;
        });
    }

    /**
     * Returns the pull request with its unresolved review threads, thread count, and Codex review summary attached.
     * Only an open or draft pull request still has feedback to act on; a merged or closed one would spend a GraphQL
     * query on threads nobody will resolve. A failed read returns the pull request unchanged instead of adding a GitHub
     * error row: the pull request and its checks are already known, and the telemetry has recorded the cause.
     */
    async attach(
        cwd: string,
        context: { owner?: string; repo?: string },
        pullRequest: PullRequest,
        isForced: boolean,
    ): Promise<PullRequest> {
        if (!pullRequest || !context.owner || !context.repo) return pullRequest;
        if (pullRequest.lifecycle !== 'open' && pullRequest.lifecycle !== 'draft')
            return pullRequest;
        try {
            const feedback = await this.feedback(
                cwd,
                { owner: context.owner, repo: context.repo, number: pullRequest.number },
                // An explicit user refresh must reach GitHub; an automatic revalidation may reuse the record.
                isForced ? 0 : undefined,
            );
            return {
                ...pullRequest,
                unresolvedReviewThreads: feedback.threads,
                reviewThreadCount: feedback.threadCount,
                codexReviews: feedback.codexReviews,
            };
        } catch (error) {
            this.telemetry.recordParseFailure('gh', error);
            return pullRequest;
        }
    }
}

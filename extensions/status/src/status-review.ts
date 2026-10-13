import type { ProjectStatusCodexReview, ProjectStatusRepository, TreeItemTooltipRow } from 'caxri';

import { fixReviewCommentsAction } from './status-agent-actions';
import type { StatusNode } from './status-item';
import { item } from './status-item';
import {
    clipMarkdown,
    markdownExcerpt,
    reviewThreadLocation,
    unresolvedCommentsLabel,
} from './status-labels';
import { stateIcons } from './status-presentation';

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;

const codexReviewIcons: Record<ProjectStatusCodexReview['state'], string> = {
    completed: stateIcons.success,
    running: stateIcons.pending,
    failed: stateIcons.failure,
    unknown: stateIcons.unknown,
};

/**
 * Whether a Codex review covered an older commit than the pull request's head. A review row that only said `Completed`
 * read as "this code was reviewed" after a push Codex had not looked at yet.
 */
function isBehindHead(review: ProjectStatusCodexReview, pullRequest: PullRequest): boolean {
    return (
        review.commit !== undefined &&
        pullRequest.headSha !== undefined &&
        !pullRequest.headSha.startsWith(review.commit)
    );
}

function codexReviewNode(
    review: ProjectStatusCodexReview,
    pullRequest: PullRequest,
    id: string,
): StatusNode {
    const label = `Codex ${review.name}`;
    const isStale = isBehindHead(review, pullRequest);
    const description = [review.status, review.commit, isStale ? 'older commit' : undefined]
        .filter(Boolean)
        .join(' · ');
    return item(id, label, {
        description,
        icon: codexReviewIcons[review.state],
        accessibilityLabel: [label, review.status, review.commit && `commit ${review.commit}`]
            .concat(isStale ? 'not the latest commit' : [])
            .filter(Boolean)
            .join(', '),
        url: review.url,
        tooltip: {
            ...(isStale && {
                description:
                    'Codex reviewed an older commit; pushes after it have not been reviewed yet.',
            }),
            rows: [
                { label: 'status', value: review.status },
                review.commit ? { label: 'commit', value: review.commit } : undefined,
                review.trigger ? { label: 'trigger', value: review.trigger } : undefined,
                review.updatedAt === undefined
                    ? undefined
                    : { label: 'updated', value: new Date(review.updatedAt).toLocaleString() },
            ].filter((row): row is TreeItemTooltipRow => row !== undefined),
        },
    });
}

/**
 * The group's trailing word. A pull request with nothing unresolved still says why it is quiet, so "every comment was
 * resolved" and "nobody has reviewed yet" never look like "Caxri did not detect the review".
 */
function reviewDescription(
    unresolved: number,
    threadCount: number,
    codexReviews: readonly ProjectStatusCodexReview[],
): string {
    if (unresolved > 0) return `${unresolved} unresolved`;
    if (codexReviews.some((review) => review.state === 'running')) return 'Reviewing';
    if (codexReviews.some((review) => review.state === 'failed')) return 'Review failed';
    if (threadCount > 0) return 'All resolved';
    return 'No comments';
}

function reviewIcon(unresolved: number, codexReviews: readonly ProjectStatusCodexReview[]): string {
    if (unresolved > 0) return 'comment-unresolved';
    if (codexReviews.some((review) => review.state === 'running')) return stateIcons.pending;
    if (codexReviews.some((review) => review.state === 'failed')) return stateIcons.failure;
    return 'comment';
}

/**
 * Vscode-fe-helper's "Unresolved Comments" group grown into the pull request's whole review state: Codex's review
 * summary rows first, then one row per unresolved thread. It stays visible on every open or draft pull request, so an
 * empty review reads as `All resolved` or `No comments` rather than as a missing row. The group opens the pull
 * request's conversation; each row opens its own comment. The `Fix` button sends every unresolved thread to the
 * Session's Agent.
 */
export function reviewNode(repo: ProjectStatusRepository, prefix: string): StatusNode | undefined {
    const pullRequest = repo.pullRequest;
    if (!pullRequest) return undefined;
    const threads = pullRequest.unresolvedReviewThreads;
    if (threads === undefined) {
        /**
         * `ReviewThreadStore.attach` only fetches threads for an open or draft pull request; a merged or closed one is
         * never asked, so an absent field there is simply "not applicable", not a failure. For an open or draft pull
         * request the field is absent only because the GraphQL read threw (see `attach`'s catch), and treating that the
         * same as `[]` told the user the review was clean when Caxri never actually checked.
         */
        if (pullRequest.lifecycle !== 'open' && pullRequest.lifecycle !== 'draft') return undefined;
        return item(`${prefix}:review`, 'Could not check review comments', {
            icon: stateIcons.unknown,
            url: pullRequest.url,
            tooltip: {
                description:
                    'GitHub review comments could not be read. Refresh Project Status to check again.',
            },
        });
    }
    const codexReviews = pullRequest.codexReviews ?? [];
    const threadCount = pullRequest.reviewThreadCount ?? threads.length;
    const description = reviewDescription(threads.length, threadCount, codexReviews);
    const summary =
        threads.length > 0 ? unresolvedCommentsLabel(threads.length) : description.toLowerCase();
    return item(`${prefix}:review`, 'Review', {
        description,
        icon: reviewIcon(threads.length, codexReviews),
        accessibilityLabel: `Review, ${summary}`,
        url: pullRequest.url,
        actions: threads.length > 0 ? [fixReviewCommentsAction(repo, pullRequest, threads)] : [],
        tooltip: {
            badge: { label: summary, tone: threads.length > 0 ? 'warning' : 'neutral' },
            description:
                'Open the pull request conversation; expand for Codex reviews and threads.',
            rows: [
                { label: 'unresolved', value: String(threads.length) },
                { label: 'threads', value: String(threadCount) },
            ],
        },
        children: [
            ...codexReviews.map((review, index) =>
                codexReviewNode(review, pullRequest, `${prefix}:codex-review:${index}`),
            ),
            ...threads.map((thread, index) => {
                const location = reviewThreadLocation(thread);
                const excerpt = markdownExcerpt(thread.body, 80);
                return item(`${prefix}:review-thread:${index}`, location, {
                    description: excerpt || undefined,
                    icon: 'comment',
                    accessibilityLabel: [location, thread.author && `by ${thread.author}`, excerpt]
                        .filter(Boolean)
                        .join(', '),
                    url: thread.url,
                    tooltip: {
                        ...(thread.body.trim() && { markdown: clipMarkdown(thread.body.trim()) }),
                        rows: [
                            thread.path ? { label: 'file', value: thread.path } : undefined,
                            thread.author
                                ? { label: 'author', value: `@${thread.author}` }
                                : undefined,
                            thread.createdAt === undefined
                                ? undefined
                                : {
                                      label: 'created',
                                      value: new Date(thread.createdAt).toLocaleString(),
                                  },
                        ].filter((row): row is TreeItemTooltipRow => row !== undefined),
                    },
                });
            }),
        ],
    });
}

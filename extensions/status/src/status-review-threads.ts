import type { ProjectStatusRepository, TreeItemTooltipRow } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import {
    clipMarkdown,
    markdownExcerpt,
    reviewThreadLocation,
    unresolvedCommentsLabel,
} from './status-labels';
import { stateIcons } from './status-presentation';

/**
 * Vscode-fe-helper's "Unresolved Comments" group: the review feedback a delivery still owes, one row per thread. The
 * group opens the pull request's conversation; each thread opens its own comment. Absent when nothing is unresolved, so
 * a clean pull request spends no row on it.
 */
export function reviewThreadsNode(
    repo: ProjectStatusRepository,
    prefix: string,
): StatusNode | undefined {
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
        return item(`${prefix}:review-threads`, 'Could not check review comments', {
            icon: stateIcons.unknown,
            url: pullRequest.url,
            tooltip: {
                description:
                    'GitHub review comments could not be read. Refresh Project Status to check again.',
            },
        });
    }
    if (threads.length === 0) return undefined;
    const summary = unresolvedCommentsLabel(threads.length);
    return item(`${prefix}:review-threads`, 'Unresolved Comments', {
        description: String(threads.length),
        icon: 'comment-unresolved',
        accessibilityLabel: `Unresolved Comments, ${summary}`,
        url: pullRequest.url,
        tooltip: {
            badge: { label: summary, tone: 'warning' },
            description: 'Open the pull request conversation; expand for individual threads.',
        },
        children: threads.map((thread, index) => {
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
                        thread.author ? { label: 'author', value: `@${thread.author}` } : undefined,
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
    });
}

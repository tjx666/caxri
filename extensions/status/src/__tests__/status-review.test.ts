import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode } from '../status-tree';

describe('Status extension review group', () => {
    it('lists unresolved review threads under one group that opens the pull request', () => {
        const pullRequestUrl = 'https://github.com/example/repo/pull/7';
        const repo: ProjectStatusRepository = {
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'feature',
            acceptances: [],
            linearIssues: [],
            errors: [],
            pullRequest: {
                number: 7,
                title: 'Feature',
                url: pullRequestUrl,
                lifecycle: 'open',
                state: 'success',
                checks: [],
                hiddenCheckCount: 0,
                unresolvedReviewThreads: [
                    {
                        url: `${pullRequestUrl}#discussion_r1`,
                        body: 'Please rename\n\nthis helper.',
                        author: 'reviewer',
                        createdAt: Date.UTC(2026, 0, 2),
                        path: 'src/app.ts',
                        line: 12,
                    },
                    { url: `${pullRequestUrl}#discussion_r2`, body: 'Overall looks good?' },
                ],
            },
        };
        const children = buildRepoNode(repo).children ?? [];
        const group = children.find((node) => node.item.label === 'Review');
        expect(group?.item).toMatchObject({
            description: '2 unresolved',
            command: { arguments: [pullRequestUrl] },
        });
        expect(group?.item.iconPath?.id).toBe('comment-unresolved');
        // The group's Fix button carries every thread to the Session's Agent.
        const [fix] = group?.item.actions ?? [];
        expect(fix).toMatchObject({ label: 'Fix', command: { command: 'caxri.sendToAgent' } });
        expect(fix.command.arguments?.[0]).toContain('## 1. src/app.ts:12 (@reviewer)');
        expect(fix.command.arguments?.[0]).toContain('Overall looks good?');
        // The group sits before the pull request row, like fe-helper's sidebar.
        expect(children.indexOf(group!)).toBeLessThan(
            children.findIndex((node) => node.item.label === '#7 Feature'),
        );
        const [inline, general] = group?.children ?? [];
        expect(inline.item).toMatchObject({
            label: 'app.ts:12',
            description: 'Please rename this helper.',
            command: { arguments: [`${pullRequestUrl}#discussion_r1`] },
        });
        const { description, markdown, rows } = inline.item.tooltip as TreeItemRichTooltip;
        // The hover card renders the authored Markdown with its paragraph breaks instead of a flattened excerpt.
        expect(markdown).toBe('Please rename\n\nthis helper.');
        expect(description).toBeUndefined();
        expect(rows).toContainEqual({ label: 'file', value: 'src/app.ts' });
        expect(rows).toContainEqual({ label: 'author', value: '@reviewer' });
        expect(general.item.label).toBe('General');
    });

    it('keeps the group on a clean pull request and says why it is quiet', () => {
        const pullRequestUrl = 'https://github.com/example/repo/pull/7';
        const summaryUrl = `${pullRequestUrl}#issuecomment-1`;
        const repo = (pullRequest: Partial<NonNullable<ProjectStatusRepository['pullRequest']>>) =>
            buildRepoNode({
                id: 'fixture',
                kind: 'primary',
                name: 'project',
                branch: 'feature',
                acceptances: [],
                linearIssues: [],
                errors: [],
                pullRequest: {
                    number: 7,
                    title: 'Feature',
                    url: pullRequestUrl,
                    lifecycle: 'open',
                    state: 'success',
                    checks: [],
                    hiddenCheckCount: 0,
                    headSha: '9e912c5'.padEnd(40, '0'),
                    unresolvedReviewThreads: [],
                    ...pullRequest,
                },
            }).children?.find((node) => node.item.id?.endsWith(':review'));
        const codexReview = {
            name: 'Code Review',
            status: 'Completed',
            state: 'completed' as const,
            commit: '9e912c5',
            trigger: 'Manual request',
            url: summaryUrl,
        };

        const untouched = repo({ reviewThreadCount: 0, codexReviews: [] });
        expect(untouched?.item.description).toBe('No comments');
        expect(untouched?.item.actions).toBeUndefined();

        // One Codex review and no threads: the review row takes the group's place instead of expanding to itself.
        const resolved = repo({ reviewThreadCount: 3, codexReviews: [codexReview] });
        expect(resolved?.item).toMatchObject({
            label: 'Codex Code Review',
            description: 'All resolved',
            command: { arguments: [summaryUrl] },
        });
        expect(resolved?.children).toBeUndefined();
        expect(resolved?.item.iconPath?.id).toBe('circle-check');
        // The icon carries the state, and a bare short SHA tells a reader nothing, so neither repeats as text.
        expect(JSON.stringify(resolved?.item)).not.toContain('9e912c5');

        const reviewing = repo({
            reviewThreadCount: 0,
            codexReviews: [{ ...codexReview, status: 'In progress', state: 'running' }],
        });
        // The spinner says it; a `Reviewing` or `In progress` word beside it only repeated it.
        expect(reviewing?.item.description).toBeUndefined();
        expect(reviewing?.item.iconPath?.id).toBe('loading');

        // Two reviews keep the group, and neither child spells out its state or commit.
        const twoReviews = repo({
            reviewThreadCount: 0,
            codexReviews: [
                { ...codexReview, status: 'In progress', state: 'running' },
                { ...codexReview, name: 'Security Review' },
            ],
        });
        expect(twoReviews?.item.label).toBe('Review');
        expect(twoReviews?.item.description).toBeUndefined();
        expect(twoReviews?.children?.map((child) => child.item.description)).toEqual([
            undefined,
            undefined,
        ]);

        const failed = repo({
            reviewThreadCount: 2,
            unresolvedReviewThreads: [{ url: `${pullRequestUrl}#discussion_r1`, body: 'Fix' }],
            codexReviews: [{ ...codexReview, status: 'Failed', state: 'failed' }],
        });
        expect(failed?.item.description).toBe('1 unresolved');
        expect(failed?.children).toHaveLength(2);

        // A push after the review leaves the review row naming the older commit it covered.
        const stale = repo({ headSha: 'a'.repeat(40), codexReviews: [codexReview] });
        expect(stale?.item.description).toBe('No comments · older commit');
    });

    it('reports a failed read instead of a clean review when the field is missing on an open pull request', () => {
        const pullRequestUrl = 'https://github.com/example/repo/pull/7';
        const repo: ProjectStatusRepository = {
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'feature',
            acceptances: [],
            linearIssues: [],
            errors: [],
            pullRequest: {
                number: 7,
                title: 'Feature',
                url: pullRequestUrl,
                lifecycle: 'open',
                state: 'success',
                checks: [],
                hiddenCheckCount: 0,
                // Absent because the GraphQL read failed (see `ReviewThreadStore.attach`'s catch branch), not because
                // every thread was resolved.
            },
        };
        const children = buildRepoNode(repo).children ?? [];
        const failure = children.find(
            (node) => node.item.label === 'Could not check review comments',
        );
        expect(failure).toBeDefined();
        expect(failure?.children).toBeUndefined();
        expect(failure?.item.command).toMatchObject({ arguments: [pullRequestUrl] });
        expect(children.some((node) => node.item.label === 'Review')).toBe(false);

        // A merged pull request never asks for threads at all, so a missing field there is not a failure.
        const merged = buildRepoNode({
            ...repo,
            pullRequest: { ...repo.pullRequest!, lifecycle: 'merged' },
        });
        expect(
            merged.children?.some((node) => node.item.label === 'Could not check review comments'),
        ).toBe(false);
    });
});

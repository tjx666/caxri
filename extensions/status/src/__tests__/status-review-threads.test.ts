import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode } from '../status-tree';

describe('Status extension review threads', () => {
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
        const group = children.find((node) => node.item.label === 'Unresolved Comments');
        expect(group?.item).toMatchObject({
            description: '2',
            command: { arguments: [pullRequestUrl] },
        });
        expect(group?.item.iconPath?.id).toBe('comment-unresolved');
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
        const { rows } = inline.item.tooltip as TreeItemRichTooltip;
        expect(rows).toContainEqual({ label: 'file', value: 'src/app.ts' });
        expect(rows).toContainEqual({ label: 'author', value: '@reviewer' });
        expect(general.item.label).toBe('General');

        const resolved = buildRepoNode({
            ...repo,
            pullRequest: { ...repo.pullRequest!, unresolvedReviewThreads: [] },
        });
        expect(resolved.children?.some((node) => node.item.label === 'Unresolved Comments')).toBe(
            false,
        );
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
        expect(children.some((node) => node.item.label === 'Unresolved Comments')).toBe(false);

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

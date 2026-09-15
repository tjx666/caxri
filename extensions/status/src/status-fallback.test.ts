import { ProjectStatusSummaryErrorMessage, TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode, buildStatusRootNodes } from './status-tree';

function iconId(node: ReturnType<typeof buildRepoNode>): string | undefined {
    return node.item.iconPath?.id;
}

describe('Project Status fallback', () => {
    it.each([
        ['not installed', 'Vercel CLI not installed'],
        ['not signed in', 'Vercel CLI not signed in'],
        ['not linked', 'Repository not linked to Vercel'],
    ])('shows the Vercel %s prerequisite under Deployments', (_scenario, message) => {
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'main',
            linearIssues: [],
            errors: [
                {
                    source: 'vercel',
                    kind: 'prerequisite',
                    message,
                    hint: 'Complete guidance, then recheck.',
                },
            ],
        });
        const deployments = root.children?.find((node) => node.item.label === 'Deployments');
        const fallback = deployments?.children?.[0]?.item;
        expect(deployments?.item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
        expect(fallback).toMatchObject({
            variant: 'message',
            label: message,
            description: 'Complete guidance, then recheck.',
        });
        expect(fallback?.iconPath?.id).toBe('cloud');
        expect(fallback?.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Refresh',
        });
    });

    it('keeps true failures actionable with a danger icon', () => {
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'main',
            linearIssues: [],
            errors: [
                {
                    source: 'github',
                    kind: 'failure',
                    message: 'GitHub CLI failed',
                    hint: 'Try again later.',
                },
            ],
        });
        const failure = root.children?.find((node) =>
            node.item.id?.endsWith(':error:github'),
        )?.item;
        expect(failure?.variant).toBe('message');
        expect(failure?.iconPath?.id).toBe('circle-x');
        expect(failure?.command?.title).toBe('Refresh');
    });

    it('coalesces network failures across providers and repositories into one refresh action', () => {
        const repo = {
            id: 'fixture',
            kind: 'primary' as const,
            name: 'project',
            branch: 'main',
            linearIssues: [],
            errors: [
                {
                    source: 'github' as const,
                    kind: 'failure' as const,
                    reason: 'network' as const,
                    message: 'No network connection',
                    hint: 'Reconnect.',
                },
                {
                    source: 'vercel' as const,
                    kind: 'failure' as const,
                    reason: 'network' as const,
                    message: 'No network connection',
                    hint: 'Reconnect.',
                },
            ],
        };
        const nodes = buildStatusRootNodes({
            repositories: [repo, { ...repo, id: 'other' }],
            refreshedAt: 1,
        });
        expect(nodes.filter((node) => node.item.label === 'No network connection')).toHaveLength(1);
        expect(nodes[0]?.item.variant).toBe('message');
        expect(nodes[0]?.item.command?.title).toBe('Refresh');
        expect(nodes[0]?.item.description).toBe(
            'Caxri could not reach GitHub and Vercel. Reconnect, then refresh.',
        );
        expect(
            nodes
                .slice(1)
                .flatMap((node) => node.children ?? [])
                .some((node) => node.item.id?.includes(':error:')),
        ).toBe(false);
    });

    it('names the affected provider when only one connection fails', () => {
        const nodes = buildStatusRootNodes({
            repositories: [
                {
                    id: 'fixture',
                    kind: 'primary',
                    name: 'project',
                    branch: 'main',
                    linearIssues: [],
                    errors: [
                        {
                            source: 'vercel',
                            kind: 'failure',
                            reason: 'network',
                            message: 'Vercel CLI connection failed',
                            hint: 'Caxri could not reach Vercel CLI. Check the connection, then recheck.',
                        },
                    ],
                },
            ],
            refreshedAt: 1,
        });
        expect(nodes[0]?.item.label).toBe('Vercel CLI connection failed');
        expect(nodes[0]?.item.description).toContain('Vercel CLI');
        expect(nodes[0]?.item.description).not.toContain('GitHub');
    });

    it('states an account-level rate limit once for the whole Project', () => {
        const now = 10_000;
        const rateLimited = {
            source: 'github' as const,
            kind: 'failure' as const,
            reason: 'rate-limited' as const,
            message: 'GitHub API limit reached',
            hint: 'Caxri paused GitHub checks to protect the shared API budget. Retries after 7:04 PM.',
            retryAt: now + 60_000,
        };
        const repo = {
            id: 'fixture',
            kind: 'primary' as const,
            name: 'project',
            branch: 'main',
            linearIssues: [],
            errors: [rateLimited],
        };
        const nodes = buildStatusRootNodes(
            {
                repositories: [repo, { ...repo, id: 'submodule', kind: 'submodule' }],
                refreshedAt: 1,
            },
            now,
        );
        const limitNodes = nodes.filter((node) => node.item.id?.startsWith('status:rate-limit'));
        expect(limitNodes).toHaveLength(1);
        expect(limitNodes[0]?.item).toMatchObject({
            variant: 'message',
            label: 'GitHub API limit reached',
            description: rateLimited.hint,
        });
        expect(limitNodes[0]?.item.iconPath?.id).toBe('hourglass');
        // Caxri resumes on its own inside the window, so there is no action to offer.
        expect(limitNodes[0]?.item.command).toBeUndefined();
        expect(
            nodes
                .flatMap((node) => node.children ?? [])
                .some((node) => node.item.id?.includes(':error:')),
        ).toBe(false);
    });

    it('offers Retry again once the recorded pause has elapsed', () => {
        const now = 10_000;
        const nodes = buildStatusRootNodes(
            {
                repositories: [
                    {
                        id: 'fixture',
                        kind: 'primary',
                        name: 'project',
                        branch: 'main',
                        linearIssues: [],
                        errors: [
                            {
                                source: 'vercel',
                                kind: 'failure',
                                reason: 'rate-limited',
                                message: 'Vercel API limit reached',
                                hint: 'Caxri paused Vercel checks to protect the shared API budget. Refresh after the limit resets.',
                                retryAt: now - 1,
                            },
                        ],
                    },
                ],
                refreshedAt: 1,
            },
            now,
        );
        expect(nodes[0]?.item.id).toBe('status:rate-limit:vercel');
        expect(nodes[0]?.item.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Refresh',
        });
    });

    it('distinguishes empty, non-Git, and summary-error messages', () => {
        const empty = buildStatusRootNodes({ repositories: [], refreshedAt: 1 });
        const nonGit = buildStatusRootNodes({
            repositories: [],
            refreshedAt: 2,
            error: ProjectStatusSummaryErrorMessage.missingGitRepository,
        });
        const failure = buildStatusRootNodes({
            repositories: [],
            refreshedAt: 3,
            error: 'Project Status is unavailable.',
        });

        expect(empty[0].item).toMatchObject({
            id: 'status:empty',
            label: 'No repositories found',
            description: 'Add a Git repository to this Project, then refresh.',
            variant: 'message',
        });
        expect(empty[0].item.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Refresh',
        });
        expect(nonGit[0].item).toMatchObject({
            id: 'status:summary:error',
            label: 'No Git repository',
            description: 'Initialize a Git repository in the Project root, then refresh.',
            variant: 'message',
        });
        expect(iconId(nonGit[0])).toBe('git-branch');
        expect(nonGit[0].item.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Refresh',
        });
        expect(failure[0].item).toMatchObject({
            id: 'status:summary:error',
            label: 'Project Status unavailable',
            description: 'Project Status is unavailable.',
            variant: 'message',
        });
        // One command, one word for it: this row used to say Retry while the two above said Refresh.
        expect(failure[0].item.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Refresh',
        });
    });
});

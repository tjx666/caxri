import { TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode, buildStatusRootNodes } from './status-tree';

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
            title: 'Recheck',
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
                    message: 'GitHub CLI rate limited',
                    hint: 'Try again later.',
                },
            ],
        });
        const failure = root.children?.find((node) =>
            node.item.id?.endsWith(':error:github'),
        )?.item;
        expect(failure?.variant).toBe('message');
        expect(failure?.iconPath?.id).toBe('circle-x');
        expect(failure?.command?.title).toBe('Retry');
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
        expect(nodes[0]?.item.command?.title).toBe('Recheck');
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
});

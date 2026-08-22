import type { ProjectStatusRepository } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode, buildStatusRootNodes } from './status-tree';

function iconId(node: ReturnType<typeof buildRepoNode>): string | undefined {
    return node.item.iconPath?.id;
}

describe('Status extension tree', () => {
    it('preserves the complete pre-extension hierarchy and stable semantic state', () => {
        const repo: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'feature/status',
            defaultBranch: 'main',
            branchUrl: 'https://github.com/tjx666/caxri/tree/feature/status',
            linearIssues: [
                {
                    identifier: 'CAX-1',
                    title: 'Completed',
                    state: 'Done',
                    stateType: 'completed',
                },
                {
                    identifier: 'CAX-2',
                    title: 'Canceled',
                    state: 'Canceled',
                    stateType: 'canceled',
                },
                {
                    identifier: 'CAX-3',
                    title: 'Duplicate',
                    state: 'Duplicate',
                    stateType: 'duplicate',
                },
                {
                    identifier: 'CAX-4',
                    title: 'Started',
                    state: 'In Progress',
                    stateType: 'started',
                },
                {
                    identifier: 'CAX-5',
                    title: 'Backlog',
                    state: 'Backlog',
                    stateType: 'backlog',
                },
            ],
            deployments: {
                url: 'https://vercel.com/tjx666/caxri/deployments',
                branchDeployments: [
                    {
                        environment: 'production',
                        hostname: 'production-branch.vercel.app',
                        state: 'success',
                        url: 'https://production-branch.vercel.app',
                    },
                    {
                        environment: 'preview',
                        hostname: 'preview-branch.vercel.app',
                        state: 'pending',
                        url: 'https://preview-branch.vercel.app',
                    },
                ],
                production: {
                    environment: 'production',
                    hostname: 'caxri.app',
                    state: 'success',
                    url: 'https://caxri.app',
                },
                preview: {
                    environment: 'preview',
                    hostname: 'preview.caxri.app',
                    state: 'failure',
                    url: 'https://preview.caxri.app',
                },
            },
            pullRequest: {
                number: 307,
                title: 'Restore Project Status',
                url: 'https://github.com/tjx666/caxri/pull/307',
                state: 'failure',
                checks: [
                    {
                        name: 'Test / App',
                        state: 'failure',
                        durationMs: 125_000,
                    },
                ],
                hiddenCheckCount: 2,
            },
            errors: [
                {
                    source: 'linear',
                    message: 'linear: error',
                    hint: 'See Runtime logs for details.',
                    detailsView: 'logs',
                },
            ],
        };

        const root = buildRepoNode(repo);
        const children = root.children ?? [];

        expect(root.item).toMatchObject({
            id: 'status:repo:repo-1',
            collapsibleState: TreeItemCollapsibleState.Expanded,
        });
        expect(iconId(root)).toBe('monitor');
        expect(children.map(({ item }) => item.label)).toEqual([
            'feature/status',
            'CAX-1 Completed',
            'CAX-2 Canceled',
            'CAX-3 Duplicate',
            'CAX-4 Started',
            'CAX-5 Backlog',
            'Deployments',
            'Production',
            'Preview',
            '#307 Restore Project Status',
            'linear: error',
        ]);
        expect(children.slice(1, 6).map(iconId)).toEqual([
            'circle-check',
            'circle-outline',
            'circle-outline',
            'loading',
            'circle-dot',
        ]);
        expect(children[6].item).toMatchObject({
            id: 'status:repo:repo-1:deployments',
            description: '2 on feature/status',
        });
        expect(children[6].children?.map(({ item }) => item.description)).toEqual([
            'production',
            'preview',
        ]);
        expect(children[7].item.description).toBe('caxri.app');
        expect(children[8].item.description).toBe('preview.caxri.app');
        expect(children[9].item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
        expect(children[9].children?.map(({ item }) => item.label)).toEqual([
            'Test / App',
            '2 ignored checks hidden',
        ]);
        expect(children[9].children?.[0].item.description).toBe('2m 5s');
        expect(children[9].children?.[1].item.iconPath?.id).toBe('eye-off');
        expect(children[10].item).toMatchObject({
            id: 'status:repo:repo-1:error:linear',
            description: 'See Runtime logs for details.',
        });
        expect(children[10].item.command).toMatchObject({ command: 'caxri.showLogs' });
    });

    it('distinguishes empty and summary-error states with retry semantics', () => {
        const empty = buildStatusRootNodes({ repositories: [], refreshedAt: 1 });
        const failure = buildStatusRootNodes({
            repositories: [],
            refreshedAt: 2,
            error: 'Project Status is unavailable.',
        });

        expect(empty[0].item).toMatchObject({
            id: 'status:empty',
            label: 'No repositories found.',
        });
        expect(failure[0].item).toMatchObject({
            id: 'status:summary:error',
            label: 'Project Status is unavailable.',
            description: 'Select to retry.',
        });
        expect(failure[0].item.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Retry Project Status',
        });
    });

    it('uses the package semantic for submodule repositories', () => {
        const node = buildRepoNode({
            id: 'repo-submodule',
            kind: 'submodule',
            name: 'dependency',
            branch: 'main',
            linearIssues: [],
            errors: [],
        });

        expect(node.item.description).toBe('submodule');
        expect(iconId(node)).toBe('package');
    });
});

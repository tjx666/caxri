import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { ProjectStatusSummaryErrorMessage, TreeItemCollapsibleState } from 'caxri';
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
            githubUrl: 'https://github.com/tjx666/caxri',
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
                        inspectorUrl: 'https://vercel.com/tjx666/caxri/production-branch',
                        createdAt: 1_700_000_000_000,
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
                    inspectorUrl: 'https://vercel.com/tjx666/caxri/production',
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
            variant: 'header',
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
            'linear-completed',
            'linear-canceled',
            'linear-canceled',
            'linear-started',
            'linear-backlog',
        ]);
        expect(children[6].children?.[1]?.item.iconPath?.id).toBe('loading');
        expect(children[6].item).toMatchObject({
            id: 'status:repo:repo-1:deployments',
            description: '2 on feature/status',
        });
        expect(children[6].children?.map(({ item }) => item.description)).toEqual([
            'production · success',
            'preview · pending',
        ]);
        expect(children[6].children?.[0].item.tooltip).toEqual({
            kind: 'rich',
            title: 'production',
            badge: { label: 'success', tone: 'success' },
            rows: [
                {
                    label: 'alias',
                    value: 'production-branch.vercel.app',
                    url: 'https://production-branch.vercel.app',
                },
                {
                    label: 'inspect',
                    value: 'logs',
                    url: 'https://vercel.com/tjx666/caxri/production-branch',
                },
                expect.objectContaining({ label: 'created' }),
            ],
        });
        expect(children[6].children?.[1].item.tooltip).toMatchObject({
            badge: { label: 'pending', tone: 'warning' },
            rows: [{ label: 'alias', value: 'preview-branch.vercel.app' }],
        });
        expect(children[7].item.description).toBe('success · caxri.app');
        expect(children[7].item.tooltip).toMatchObject({
            title: 'Production',
            badge: { label: 'success', tone: 'success' },
            rows: [{ label: 'alias' }, { label: 'inspect', value: 'logs' }],
        });
        expect(children[8].item.description).toBe('failure · preview.caxri.app');
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

    it('uses static Linear workflow glyphs without changing Vercel loading feedback', () => {
        const repo: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'main',
            linearIssues: [
                { identifier: 'CAX-1', stateType: 'triage' },
                { identifier: 'CAX-2', stateType: 'unstarted' },
                { identifier: 'CAX-3', stateType: 'started' },
                { identifier: 'CAX-4', stateType: 'completed' },
                { identifier: 'CAX-5', stateType: 'canceled' },
                { identifier: 'CAX-6', stateType: 'duplicate' },
            ],
            deployments: {
                url: 'https://vercel.com/tjx666/caxri/deployments',
                branchDeployments: [
                    {
                        environment: 'preview',
                        hostname: 'preview.caxri.app',
                        state: 'pending',
                        url: 'https://preview.caxri.app',
                    },
                ],
            },
            errors: [],
        };

        const children = buildRepoNode(repo).children ?? [];
        expect(children.slice(1, 7).map(iconId)).toEqual([
            'linear-triage',
            'linear-unstarted',
            'linear-started',
            'linear-completed',
            'linear-canceled',
            'linear-canceled',
        ]);
        expect(children[7].children?.[0]?.item.iconPath?.id).toBe('loading');
    });

    it('gives every row the shared rich hover card instead of a plain string', () => {
        const repo: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'submodule',
            name: 'caxri',
            branch: 'feature/status',
            defaultBranch: 'main',
            githubUrl: 'https://github.com/tjx666/caxri',
            branchUrl: 'https://github.com/tjx666/caxri/tree/feature/status',
            linearIssues: [
                {
                    identifier: 'CAX-4',
                    title: 'Started',
                    state: 'In Progress',
                    stateType: 'started',
                    url: 'https://linear.app/caxri/issue/CAX-4',
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
                        url: 'https://github.com/tjx666/caxri/actions/runs/1',
                    },
                ],
                hiddenCheckCount: 1,
            },
            errors: [
                {
                    source: 'github',
                    message: 'gh: rate limited',
                    hint: 'Refresh after the API limit resets.',
                },
            ],
        };

        const root = buildRepoNode(repo);
        const children = root.children ?? [];
        const [branch, issue, deployments, pullRequest, error] = children;
        const [check, hiddenChecks] = pullRequest.children ?? [];

        expect(
            [root, ...children, ...(pullRequest.children ?? [])].map(
                ({ item }) => typeof item.tooltip,
            ),
        ).toEqual(Array.from({ length: 8 }, () => 'object'));
        expect(root.item.tooltip).toEqual({
            kind: 'rich',
            title: 'caxri',
            badge: { label: 'submodule', tone: 'neutral' },
            rows: [
                { label: 'branch', value: 'feature/status' },
                {
                    label: 'repository',
                    value: 'github.com/tjx666/caxri',
                    url: 'https://github.com/tjx666/caxri',
                },
            ],
        });
        expect(branch.item.tooltip).toEqual({
            kind: 'rich',
            title: 'feature/status',
            rows: [
                { label: 'default', value: 'main' },
                {
                    label: 'link',
                    value: 'github.com/tjx666/caxri/tree/feature/status',
                    url: 'https://github.com/tjx666/caxri/tree/feature/status',
                },
            ],
        });
        expect(issue.item.tooltip).toEqual({
            kind: 'rich',
            title: 'CAX-4 Started',
            badge: { label: 'In Progress', tone: 'warning' },
            rows: [
                {
                    label: 'link',
                    value: 'linear.app/caxri/issue/CAX-4',
                    url: 'https://linear.app/caxri/issue/CAX-4',
                },
            ],
        });
        expect(deployments.item.tooltip).toEqual({
            kind: 'rich',
            title: 'Deployments',
            rows: [
                { label: 'branch', value: 'feature/status' },
                { label: 'production', value: '1' },
                { label: 'preview', value: '1' },
                {
                    label: 'project',
                    value: 'vercel.com/tjx666/caxri/deployments',
                    url: 'https://vercel.com/tjx666/caxri/deployments',
                },
            ],
        });
        expect(pullRequest.item.tooltip).toEqual({
            kind: 'rich',
            title: '#307 Restore Project Status',
            badge: { label: 'failure', tone: 'danger' },
            rows: [
                { label: 'hidden', value: '1 ignored check' },
                {
                    label: 'link',
                    value: 'github.com/tjx666/caxri/pull/307',
                    url: 'https://github.com/tjx666/caxri/pull/307',
                },
            ],
        });
        expect(check.item.tooltip).toEqual({
            kind: 'rich',
            title: 'Test / App',
            badge: { label: 'failure', tone: 'danger' },
            rows: [
                { label: 'duration', value: '2m 5s' },
                {
                    label: 'logs',
                    value: 'github.com/tjx666/caxri/actions/runs/1',
                    url: 'https://github.com/tjx666/caxri/actions/runs/1',
                },
            ],
        });
        // A row with nothing structured to add keeps the same card and simply renders no list.
        expect(hiddenChecks.item.tooltip).toEqual({
            kind: 'rich',
            title: '1 ignored check hidden',
            rows: [],
        });
        expect(error.item.tooltip).toEqual({
            kind: 'rich',
            title: 'gh: rate limited',
            description: 'Refresh after the API limit resets.',
            badge: { label: 'github', tone: 'danger' },
            rows: [],
        });
    });

    it('never repeats a row destination the tooltip already publishes', () => {
        const node = buildRepoNode({
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'main',
            defaultBranch: 'main',
            linearIssues: [],
            deployments: {
                url: 'https://vercel.com/tjx666/caxri/deployments',
                branchDeployments: [],
                production: {
                    environment: 'production',
                    hostname: 'caxri.app',
                    state: 'success',
                    url: 'https://caxri.app',
                },
            },
            errors: [],
        });
        const production = node.children?.at(-1);

        expect(production?.item.command).toMatchObject({ arguments: ['https://caxri.app'] });
        expect(production?.item.tooltip).toEqual({
            kind: 'rich',
            title: 'Production',
            badge: { label: 'success', tone: 'success' },
            rows: [{ label: 'alias', value: 'caxri.app', url: 'https://caxri.app' }],
        });
    });

    it('clamps a link long enough to breach the tooltip row bound', () => {
        const deploymentsUrl = `https://vercel.com/tjx666/caxri/deployments?filterBranch=${'a'.repeat(4_000)}`;
        const node = buildRepoNode({
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'main',
            defaultBranch: 'main',
            linearIssues: [],
            deployments: { url: deploymentsUrl, branchDeployments: [] },
            errors: [],
        });
        const deployments = node.children?.find(({ item }) => item.label === 'Deployments');
        const tooltip = deployments?.item.tooltip;

        expect(typeof tooltip).toBe('object');
        const project = (tooltip as TreeItemRichTooltip).rows?.at(-1);
        // The row value is capped at 2048 characters by the process boundary, so an unclamped link would reject the
        // whole `getChildren` batch instead of degrading this one row.
        expect(project?.value.length).toBeLessThanOrEqual(256);
        expect(project?.value.endsWith('…')).toBe(true);
        // The clamp is display-only: the row still opens the complete destination.
        expect(project?.url).toBe(deploymentsUrl);
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
        expect(failure[0].item.command).toMatchObject({
            command: 'caxri.project-status.refresh',
            title: 'Retry',
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

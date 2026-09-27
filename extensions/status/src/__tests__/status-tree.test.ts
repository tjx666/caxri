import type { ProjectStatusRepository, TreeItemRichTooltip } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import { deploymentStateLabel } from '../status-labels';
import { buildRepoNode } from '../status-tree';

function iconId(node: ReturnType<typeof buildRepoNode>): string | undefined {
    return node.item.iconPath?.id;
}

describe('Status extension tree', () => {
    it.each(['neutral', 'failure', 'success', 'pending'] as const)(
        'opens deployment details from every row for %s deployments',
        (state) => {
            const deployment = {
                environment: 'preview' as const,
                hostname: 'fixture.vercel.app',
                state,
                url: 'https://fixture.vercel.app',
                inspectorUrl: 'https://vercel.com/team/project/Deployment123',
            };
            const root = buildRepoNode({
                id: 'fixture',
                kind: 'primary',
                name: 'project',
                branch: 'main',
                acceptances: [],
                linearIssues: [],
                errors: [],
                deployments: {
                    url: 'https://vercel.com/team/project/deployments',
                    branchDeployments: [deployment],
                    production: { ...deployment, environment: 'production' },
                    preview: deployment,
                },
            });
            const rows = (root.children ?? [])
                .flatMap((node) => node.children ?? [node])
                .filter((node) =>
                    ['Production', 'Preview', deployment.hostname].includes(node.item.label),
                );
            // The fixture's `preview` is the exact deployment `branchDeployments` already lists, so the summary loop
            // skips a second "Preview" row for it (#1291); `production` names a different environment for the same
            // hostname, which is not something `branchDeployments` already says, so it keeps its own row.
            expect(rows.map((row) => row.item.label)).toEqual([deployment.hostname, 'Production']);
            for (const row of rows) {
                // Through the shared mapping, so the row never prints the provider's own word for the state.
                const stateLabel = deploymentStateLabel(deployment);
                expect(row.item.accessibilityInformation?.label).toContain(stateLabel);
                expect(row.item.tooltip).toMatchObject({ badge: { label: stateLabel } });
                // The environment rows keep the hash-heavy alias out of the row, never out of reach.
                if (row.item.label !== deployment.hostname)
                    expect(row.item.description).toBeUndefined();
                expect(row.item.accessibilityInformation?.label).toContain(deployment.hostname);
                if (state === 'neutral') {
                    expect(row.item.iconPath?.id).toBe('circle-slash');
                    expect(row.item.accessibilityInformation?.label).toContain('canceled');
                    expect(row.item.tooltip).toMatchObject({
                        badge: { label: 'canceled', tone: 'neutral' },
                    });
                }
                expect(row.item.command?.arguments).toEqual([deployment.inspectorUrl]);
                const tooltip = row.item.tooltip as TreeItemRichTooltip;
                expect(tooltip.rows).toContainEqual({
                    label: 'alias',
                    value: deployment.hostname,
                    url: deployment.url,
                });
                expect(tooltip.rows).toContainEqual({
                    label: 'inspect',
                    value: 'details',
                    url: deployment.inspectorUrl,
                });
            }
        },
    );

    it.each(['primary', 'submodule'] as const)(
        'keeps merged %s PRs distinct from every CI result',
        (kind) => {
            for (const [state, checkLabel, checkIcon, badgeLabel] of [
                ['success', 'CI passed', 'circle-check', 'passed'],
                ['failure', 'CI failed', 'circle-x', 'failed'],
                ['pending', 'CI running', 'loading', 'running'],
                ['queued', 'CI queued', 'circle-small-filled', 'queued'],
                ['neutral', 'CI neutral', 'circle-outline', 'neutral'],
                ['unknown', 'CI unknown', 'circle-dot', 'unknown'],
            ] as const) {
                const root = buildRepoNode({
                    id: 'fixture',
                    name: 'fixture',
                    branch: 'feature/status',
                    kind,
                    acceptances: [],
                    linearIssues: [],
                    errors: [],
                    pullRequest: {
                        number: 42,
                        title: 'Lifecycle fixture',
                        url: 'https://github.com/a/b/pull/42',
                        lifecycle: 'merged',
                        state,
                        hiddenCheckCount: 0,
                        checks: [{ name: 'Build', state }],
                    },
                });
                const pr = root.children!.find((node) => node.item.id?.endsWith(':pr'))!;
                const branch = root.children!.find((node) => node.item.id?.endsWith(':branch'))!;
                expect(iconId(pr)).toBe(checkIcon);
                expect(iconId(branch)).toBe('git-merge');
                expect(pr.item.trailingIcon).toBeUndefined();
                expect(pr.item.description).toBeUndefined();
                expect(pr.item.accessibilityInformation?.label).toBe(
                    `#42 Lifecycle fixture, Merged, ${checkLabel}`,
                );
                expect(pr.item.tooltip).toMatchObject({ badge: { label: 'Merged' } });
                expect((pr.item.tooltip as TreeItemRichTooltip).rows).toContainEqual({
                    label: 'checks',
                    value: checkLabel,
                });
                expect(pr.children?.[0].item.tooltip).toMatchObject({
                    badge: { label: badgeLabel },
                });
                expect(pr.item.collapsibleState).toBe(
                    state === 'failure'
                        ? TreeItemCollapsibleState.Expanded
                        : TreeItemCollapsibleState.Collapsed,
                );
            }
        },
    );

    it('renders cancellation with a neutral slash icon and explicit tooltip', () => {
        const node = buildRepoNode({
            id: 'repo',
            kind: 'primary',
            name: 'Project',
            branch: 'feature',
            acceptances: [],
            linearIssues: [],
            errors: [],
            pullRequest: {
                number: 1,
                title: 'Cancelled',
                url: 'https://github.com/a/b/pull/1',
                lifecycle: 'open',
                state: 'cancelled',
                hiddenCheckCount: 0,
                checks: [{ name: 'Build', state: 'cancelled' }],
            },
        });
        const pr = node.children?.find((child) => child.item.id === 'status:repo:repo:pr');
        /**
         * The PR row's leading icon carries the aggregate check state while the branch row's icon and this row's badge
         * carry the lifecycle, so a cancellation surfaces on the leading icon and the `checks` row. Both stay neutral —
         * a check cancelled by concurrency is not a closed PR and not a failure.
         */
        expect(pr?.item.iconPath?.id).toBe('circle-slash');
        expect(pr?.item.trailingIcon).toBeUndefined();
        const branch = node.children?.find((child) => child.item.id?.endsWith(':branch'));
        expect(branch?.item.iconPath?.id).toBe('git-pull-request-open');
        expect(pr?.item.description).toBeUndefined();
        expect(pr?.item.accessibilityInformation?.label).toBe('#1 Cancelled, Open, CI canceled');
        expect((pr?.item.tooltip as TreeItemRichTooltip).rows).toContainEqual({
            label: 'checks',
            value: 'CI canceled',
        });
        const check = pr?.children?.[0]?.item;
        expect(check?.iconPath?.id).toBe('circle-slash');
        expect(check?.tooltip).toMatchObject({ badge: { label: 'canceled', tone: 'neutral' } });
    });

    it.each([
        ['open', 'git-pull-request-open', 'Open'],
        ['draft', 'git-pull-request-draft', 'Draft'],
        ['closed', 'git-pull-request-closed', 'Closed'],
        // An unreported lifecycle leaves the branch row on its own glyph rather than asserting a state.
        [undefined, 'git-branch', 'Not reported'],
    ] as const)(
        'shows %s lifecycle on the branch row without treating CI success as an open PR',
        (lifecycle, icon, label) => {
            const root = buildRepoNode({
                id: 'fixture',
                name: 'fixture',
                branch: 'feature/status',
                kind: 'primary',
                acceptances: [],
                linearIssues: [],
                errors: [],
                pullRequest: {
                    number: 42,
                    title: 'Lifecycle fixture',
                    url: 'https://github.com/a/b/pull/42',
                    lifecycle,
                    state: 'success',
                    hiddenCheckCount: 0,
                    checks: [],
                },
            });
            const pr = root.children!.find((node) => node.item.id?.endsWith(':pr'))!;
            const branch = root.children!.find((node) => node.item.id?.endsWith(':branch'))!;
            expect(iconId(pr)).toBe('circle-check');
            expect(pr.item.trailingIcon).toBeUndefined();
            expect(iconId(branch)).toBe(icon);
            /**
             * Neither status is spelled out in either row — the two icons carry them in GitHub's own colors — so both
             * have to remain reachable through the accessible names for a reader who cannot use color.
             */
            expect(pr.item.description).toBeUndefined();
            expect(pr.item.accessibilityInformation?.label).toBe(
                `#42 Lifecycle fixture, ${label}, CI passed`,
            );
            expect(branch.item.accessibilityInformation?.label).toBe(
                lifecycle ? `feature/status, pull request #42 ${label}` : 'feature/status',
            );
        },
    );

    it.each([
        ['unpublished', 'Not on origin'],
        ['synced', 'Synced'],
        ['ahead', '↑2'],
        ['behind', '↓1'],
        ['diverged', '↑2 ↓1'],
        ['published', 'On origin'],
        // A probe that failed and a remote nobody can probe are different answers, so they get different words.
        ['unknown', 'Check failed'],
        ['unsupported', 'Not supported'],
    ] as const)(
        'makes %s publication visible and explains its comparison target',
        (state, label) => {
            const repo: ProjectStatusRepository = {
                id: 'repo',
                kind: 'submodule',
                name: 'project',
                branch: 'feature/status',
                defaultBranch: 'feature/status',
                acceptances: [],
                linearIssues: [],
                errors: [],
                publication: {
                    state,
                    ahead: 2,
                    behind: 1,
                    remoteBranch: 'origin/feature/status',
                    checkedAt: 123,
                },
            };
            const branch = buildRepoNode(repo).children?.[0].item;
            const tooltip = branch?.tooltip as TreeItemRichTooltip;
            // `Synced` is the steady state and asks nothing of the reader, so only the hover card says it.
            if (state === 'synced') {
                expect(branch?.description).toBe('default');
                expect(branch?.accessibilityInformation?.label).not.toContain(label);
            } else {
                expect(branch?.description).toBe(`default · ${label}`);
                expect(branch?.accessibilityInformation?.label).toContain(label);
            }
            expect(tooltip.badge?.label).toBe(label);
            expect(tooltip.rows).toContainEqual({
                label: 'compared branch',
                value: 'origin/feature/status',
            });
            expect(tooltip.rows?.some((row) => row.label === 'checked')).toBe(true);
            expect(branch?.command).toBeUndefined();
        },
    );

    it('preserves the complete pre-extension hierarchy and stable semantic state', () => {
        const repo: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'feature/status',
            defaultBranch: 'main',
            githubUrl: 'https://github.com/tjx666/caxri',
            branchUrl: 'https://github.com/tjx666/caxri/tree/feature/status',
            acceptances: [],
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
                    kind: 'failure',
                    message: 'linear: error',
                    hint: 'Something went wrong while loading linked issues. Open Logs for details.',
                    logs: { filter: 'project_status.cli', levels: ['warn', 'error'] },
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
        expect(iconId(root)).toBe('repo');
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
            'linear-duplicate',
            'linear-started',
            'linear-backlog',
        ]);
        // The glyph already carries the workflow state in the workspace's own color, so no row repeats it as text.
        expect(children.slice(1, 6).every(({ item }) => item.description === undefined)).toBe(true);
        expect(children[1].item.accessibilityInformation?.label).toBe('CAX-1, Completed, Done');
        expect(children[1].item.tooltip).toMatchObject({ badge: { label: 'Done' } });
        expect(children[6].children?.[1]?.item.iconPath?.id).toBe('loading');
        expect(children[6].item).toMatchObject({
            id: 'status:repo:repo-1:deployments',
            description: '2 on feature/status',
        });
        // Neither branch row is also this fixture's current Production/Preview (different hostnames below), so the
        // description names only the environment, with no "Latest" marker and no trailing icon to carry the same
        // fact silently (#1291).
        expect(children[6].children?.map(({ item }) => item.description)).toEqual([
            'Production',
            'Preview',
        ]);
        expect(children[6].children?.map(({ item }) => item.trailingIcon)).toEqual([
            undefined,
            undefined,
        ]);
        expect(children[6].children?.[0].item.tooltip).toEqual({
            kind: 'rich',
            title: 'Production',
            badge: { label: 'passed', tone: 'success' },
            rows: [
                {
                    label: 'alias',
                    value: 'production-branch.vercel.app',
                    url: 'https://production-branch.vercel.app',
                },
                {
                    label: 'inspect',
                    value: 'details',
                    url: 'https://vercel.com/tjx666/caxri/production-branch',
                },
                expect.objectContaining({ label: 'created' }),
            ],
        });
        expect(children[6].children?.[1].item.tooltip).toMatchObject({
            badge: { label: 'running', tone: 'warning' },
            rows: [{ label: 'alias', value: 'preview-branch.vercel.app' }],
        });
        /**
         * The environment rows print no alias: a Vercel hostname is mostly a generated hash, so it stays on the hover
         * card and in the accessible name instead of taking half the row's width to be truncated.
         */
        expect(children[7].item.description).toBeUndefined();
        /**
         * The one row on this panel that means the work is live gets its own glyph. A green check shared with every
         * passing CI check answered "did a check pass?", never "did it ship?".
         */
        expect(iconId(children[7])).toBe('rocket-success');
        expect(iconId(children[6].children![0])).toBe('rocket-success');
        // Preview keeps the shared state glyph, and so does a production deployment that did not succeed.
        expect(iconId(children[8])).toBe('circle-x');
        expect(iconId(children[6].children![1])).toBe('loading');
        expect(children[7].item.accessibilityInformation?.label).toBe(
            'Production, passed · caxri.app',
        );
        expect(children[7].item.tooltip).toMatchObject({
            title: 'Production',
            badge: { label: 'passed', tone: 'success' },
            rows: [{ label: 'alias' }, { label: 'inspect', value: 'details' }],
        });
        expect(children[8].item.description).toBeUndefined();
        expect(children[9].item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
        expect(children[9].children?.map(({ item }) => item.label)).toEqual([
            'Test / App',
            '2 ignored checks hidden',
        ]);
        expect(children[9].children?.[0].item.description).toBe('2m 5s');
        expect(children[9].children?.[1].item.iconPath?.id).toBe('eye-off');
        expect(children[10].item).toMatchObject({
            id: 'status:repo:repo-1:error:linear',
            description: 'Something went wrong while loading linked issues. Open Logs for details.',
        });
        // The query rides along, or the panel this opens holds every process's records and the user is back to guessing.
        expect(children[10].item.command).toMatchObject({
            command: 'caxri.showLogs',
            arguments: [{ filter: 'project_status.cli', levels: ['warn', 'error'] }],
        });
    });

    it('uses static Linear workflow glyphs without changing Vercel loading feedback', () => {
        const repo: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'main',
            acceptances: [],
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
            'linear-duplicate',
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
            acceptances: [],
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
                    kind: 'failure',
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
            badge: { label: 'In Progress', tone: 'neutral' },
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
            badge: { label: 'Not reported', tone: 'neutral' },
            rows: [
                { label: 'checks', value: 'CI failed' },
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
            badge: { label: 'failed', tone: 'danger' },
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

    it('keeps the alias explicit without opening it when deployment details are missing', () => {
        const node = buildRepoNode({
            id: 'repo-1',
            kind: 'primary',
            name: 'caxri',
            branch: 'main',
            defaultBranch: 'main',
            acceptances: [],
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

        expect(production?.item.command).toBeUndefined();
        expect(production?.item.tooltip).toEqual({
            kind: 'rich',
            title: 'Production',
            badge: { label: 'passed', tone: 'success' },
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
            acceptances: [],
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

    /**
     * Linear files "In Progress", "In Review", and "Ready to Merge" all under the `started` type, and each workspace
     * picks their colors itself. Quantizing that back to a Caxri tone is what made a state Linear shows green render
     * yellow, so the workspace's own color rides through to the icon untouched.
     */
    it('tints a Linear issue icon with the workflow color the workspace configured', () => {
        const [inReview, inProgress] =
            buildRepoNode({
                id: 'repo',
                kind: 'primary',
                name: 'caxri',
                branch: 'main',
                acceptances: [],
                linearIssues: [
                    {
                        identifier: 'CAX-1',
                        title: 'Review',
                        state: 'In Review',
                        stateType: 'started',
                        stateColor: '#4CB782',
                    },
                    {
                        identifier: 'CAX-2',
                        title: 'Progress',
                        state: 'In Progress',
                        stateType: 'started',
                    },
                ],
                errors: [],
            }).children?.slice(1, 3) ?? [];

        expect(inReview.item.iconPath).toMatchObject({ id: 'linear-started', color: '#4CB782' });
        expect(inReview.item.tooltip).toMatchObject({ badge: { label: 'In Review' } });
        // Without a workspace color the icon inherits the row's theme color, exactly like every Caxri-owned glyph.
        expect(inProgress.item.iconPath?.color).toBeUndefined();
    });

    it('uses the VS Code archive codicon for submodule repositories', () => {
        const node = buildRepoNode({
            id: 'repo-submodule',
            kind: 'submodule',
            name: 'dependency',
            branch: 'main',
            acceptances: [],
            linearIssues: [],
            errors: [],
        });

        expect(node.item.description).toBe('submodule');
        expect(iconId(node)).toBe('archive');
    });
});

import type { TreeItemRichTooltip } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoNode } from '../status-tree';

/**
 * Split out of `status-tree.test.ts` (`source-layout`'s per-topic split, already used by
 * `status-tree-acceptance.test.ts`) so branch-row coverage keeps growing without pushing the shared file over the
 * `max-lines` budget.
 */
describe('Status extension branch row', () => {
    // A known PR lifecycle would otherwise win the branch icon; the in-flight probe must override it so
    // "Checking origin…" is never paired with a static glyph that looks finished.
    it('wears the pending spinner while checking, even over a known PR lifecycle', () => {
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'feature/status',
            acceptances: [],
            linearIssues: [],
            errors: [],
            pullRequest: {
                number: 9,
                title: 'PR',
                url: 'https://github.com/a/b/pull/9',
                lifecycle: 'open',
                state: 'success',
                hiddenCheckCount: 0,
                checks: [],
            },
            publication: { state: 'checking' },
        });
        const branch = root.children!.find((node) => node.item.id?.endsWith(':branch'))!;
        expect(branch.item.iconPath?.id).toBe('loading');
    });

    /**
     * The pull request row sits under the checked-out branch, so one the Agent opened from another worktree must name
     * its own branch rather than read as that branch's.
     */
    it('names the pull request branch only when it is not the checked-out branch', () => {
        const pullRequestRow = (headBranch: string) =>
            buildRepoNode({
                id: 'repo',
                kind: 'primary',
                name: 'Project',
                branch: 'main',
                acceptances: [],
                linearIssues: [],
                errors: [],
                pullRequest: {
                    number: 2,
                    title: 'Delivery',
                    url: 'https://github.com/a/b/pull/2',
                    lifecycle: 'open',
                    state: 'success',
                    hiddenCheckCount: 0,
                    checks: [],
                    headBranch,
                },
            }).children?.find((child) => child.item.id === 'status:repo:repo:pr')?.item;

        const elsewhere = pullRequestRow('feat/delivery');
        expect((elsewhere?.tooltip as TreeItemRichTooltip).rows).toContainEqual({
            label: 'branch',
            value: 'feat/delivery',
        });
        expect(elsewhere?.accessibilityInformation?.label).toContain('from feat/delivery');

        const here = pullRequestRow('main');
        expect(
            (here?.tooltip as TreeItemRichTooltip).rows?.some((row) => row.label === 'branch'),
        ).toBe(false);
    });

    it('names the base branch the pull request merges into', () => {
        const pullRequestRow = (baseBranch?: string) =>
            buildRepoNode({
                id: 'repo',
                kind: 'primary',
                name: 'Project',
                branch: 'feat/delivery',
                acceptances: [],
                linearIssues: [],
                errors: [],
                pullRequest: {
                    number: 3,
                    title: 'Delivery',
                    url: 'https://github.com/a/b/pull/3',
                    lifecycle: 'open',
                    state: 'success',
                    hiddenCheckCount: 0,
                    checks: [],
                    ...(baseBranch && { baseBranch }),
                },
            }).children?.find((child) => child.item.id === 'status:repo:repo:pr')?.item;

        expect((pullRequestRow('release/1.x')?.tooltip as TreeItemRichTooltip).rows?.[0]).toEqual({
            label: 'base',
            value: 'release/1.x',
        });
        expect(
            (pullRequestRow()?.tooltip as TreeItemRichTooltip).rows?.some(
                (row) => row.label === 'base',
            ),
        ).toBe(false);
    });
});

/**
 * A Session keeps its last delivery on the repository row after moving to a new branch; the retained pull request is
 * history and must not color the current branch (#2147).
 */
describe('Status extension branch row ownership of the pull request lifecycle', () => {
    const build = (headBranch: string | undefined, lifecycle: 'merged' | 'open' | 'closed') =>
        buildRepoNode({
            id: 'repo',
            kind: 'primary',
            name: 'Project',
            branch: 'feat/current',
            acceptances: [],
            linearIssues: [],
            errors: [],
            pullRequest: {
                number: 7,
                title: 'Previous delivery',
                url: 'https://github.com/a/b/pull/7',
                lifecycle,
                state: 'success',
                hiddenCheckCount: 0,
                checks: [],
                ...(headBranch && { headBranch }),
            },
        });
    const rows = (root: ReturnType<typeof buildRepoNode>) => ({
        branch: root.children!.find((node) => node.item.id?.endsWith(':branch'))!,
        pr: root.children!.find((node) => node.item.id?.endsWith(':pr'))!,
    });

    it.each([['feat/previous'], [undefined]])(
        'keeps the plain branch glyph for a merged pull request from %s',
        (headBranch) => {
            const { branch, pr } = rows(build(headBranch, 'merged'));
            expect(branch.item.iconPath?.id).toBe('git-branch');
            expect(branch.item.accessibilityInformation?.label).not.toContain('Merged');
            expect(JSON.stringify(branch.item.tooltip)).not.toContain('Merged');
            // The pull request row keeps its own real state rather than degrading to "Not reported".
            expect(pr.item.accessibilityInformation?.label).toContain('Merged');
            expect(JSON.stringify(pr.item.tooltip)).not.toContain('Not reported');
        },
    );

    it.each([
        ['merged', 'git-merge'],
        ['open', 'git-pull-request-open'],
        ['closed', 'git-pull-request-closed'],
    ] as const)('wears the %s glyph when the head is the current branch', (lifecycle, icon) => {
        const { branch } = rows(build('feat/current', lifecycle));
        expect(branch.item.iconPath?.id).toBe(icon);
    });
});

import { describe, expect, it } from 'vitest';

import { buildRepoNode } from '../status-tree';

/**
 * Split out of `status-tree.test.ts` (`source-layout`'s per-topic split, already used by
 * `status-tree-acceptance.test.ts` and `status-tree-branch.test.ts`) so Deployments-row coverage keeps growing without
 * pushing the shared file over the `max-lines` budget.
 */
describe('Status extension Deployments row', () => {
    it('marks a branch row "Latest" and drops its summary twin when Production and Preview overlap branchDeployments', () => {
        const production = {
            environment: 'production' as const,
            hostname: 'caxri.vercel.app',
            state: 'success' as const,
            url: 'https://caxri.vercel.app',
            commit: {
                sha: 'c8c65abfeed00000000000000000000000000000',
                message: 'fix(workspace-seats) tighten the seat check',
            },
        };
        const preview = {
            environment: 'preview' as const,
            hostname: 'caxri-preview.vercel.app',
            state: 'success' as const,
            url: 'https://caxri-preview.vercel.app',
            commit: {
                sha: 'f722d1cfeed00000000000000000000000000000',
                message: 'refactor(ui) simplify the status tree',
            },
        };
        const olderProductionDeployment = {
            environment: 'production' as const,
            hostname: 'caxri-older.vercel.app',
            state: 'success' as const,
            url: 'https://caxri-older.vercel.app',
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
                // The branch's own history already carries today's Production and Preview builds: the exact
                // scenario #1291 reported as the same commit rendering twice, once here and once as a bare
                // "Production"/"Preview" summary row with no visible text telling the two apart.
                branchDeployments: [production, preview, olderProductionDeployment],
                production,
                preview,
            },
        });
        const deployments = root.children?.find((node) => node.item.label === 'Deployments');
        const rowLabels = deployments?.children?.map((node) => node.item.label);
        expect(rowLabels).toEqual([
            'fix(workspace-seats) tighten the seat check',
            'refactor(ui) simplify the status tree',
            olderProductionDeployment.hostname,
        ]);
        // Each overlapping row says which environment it is and that it is the current one, in text, not only via
        // an unlabelled trailing glyph.
        expect(deployments?.children?.map((node) => node.item.description)).toEqual([
            'Production · Latest',
            'Preview · Latest',
            'Production',
        ]);
        // No separate top-level "Production"/"Preview" row repeats either commit a second time.
        expect(root.children?.map((node) => node.item.label)).not.toContain('Production');
        expect(root.children?.map((node) => node.item.label)).not.toContain('Preview');
    });

    it('keeps a Production/Preview summary row that branchDeployments does not already carry', () => {
        const branchDeployment = {
            environment: 'preview' as const,
            hostname: 'caxri-branch.vercel.app',
            state: 'success' as const,
            url: 'https://caxri-branch.vercel.app',
        };
        // A merge-commit Production build (`mergeCommit` in `project-status/vercel.ts`) can land outside this
        // branch's own `branchDeployments` history entirely, so it stays a real, non-duplicate fact worth its own row.
        const production = {
            environment: 'production' as const,
            hostname: 'caxri-production.vercel.app',
            state: 'success' as const,
            url: 'https://caxri-production.vercel.app',
        };
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'feature',
            acceptances: [],
            linearIssues: [],
            errors: [],
            deployments: {
                url: 'https://vercel.com/team/project/deployments',
                branchDeployments: [branchDeployment],
                production,
            },
        });
        // `feature` is the always-present branch row; `Deployments` and `Production` follow it.
        expect(root.children?.map((node) => node.item.label)).toEqual([
            'feature',
            'Deployments',
            'Production',
        ]);
    });

    it('drops the empty "Deployments" row for a detached HEAD with nothing deployed', () => {
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            // Git's own internal name for a detached HEAD (`status.ts`'s `parseGitStatus`), never something to print
            // as though it were a real branch, and never worth an empty "Deployments 0 on detached" row either.
            branch: 'detached',
            acceptances: [],
            linearIssues: [],
            errors: [],
            deployments: {
                url: 'https://vercel.com/team/project/deployments',
                branchDeployments: [],
            },
        });
        expect(root.children?.some((node) => node.item.label === 'Deployments')).toBe(false);
    });

    it('drops the empty detached "Deployments" row even when a separate Production summary still applies', () => {
        const production = {
            environment: 'production' as const,
            hostname: 'caxri.vercel.app',
            state: 'success' as const,
            url: 'https://caxri.vercel.app',
        };
        const root = buildRepoNode({
            id: 'fixture',
            kind: 'primary',
            name: 'project',
            branch: 'detached',
            acceptances: [],
            linearIssues: [],
            errors: [],
            deployments: {
                url: 'https://vercel.com/team/project/deployments',
                branchDeployments: [],
                production,
            },
        });
        expect(root.children?.some((node) => node.item.label === 'Deployments')).toBe(false);
        expect(root.children?.map((node) => node.item.label)).toContain('Production');
    });

    it('drops a branch row leading gitmoji rather than stacking it on the state icon', () => {
        const deployment = {
            environment: 'preview' as const,
            hostname: 'caxri.vercel.app',
            state: 'success' as const,
            url: 'https://caxri.vercel.app',
            commit: {
                sha: 'c8c65abfeed00000000000000000000000000000',
                message: '✨ feat: add the status rollup',
            },
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
            },
        });
        const deployments = root.children?.find((node) => node.item.label === 'Deployments');
        const row = deployments?.children?.[0]?.item;
        expect(row?.label).toBe('feat: add the status rollup');
        // Dropped only from the visible label, which already carries `deploymentIcon`'s own state glyph: the raw
        // message, gitmoji included, still reaches the screen reader exactly as it did before this row started
        // stripping anything.
        expect(row?.accessibilityInformation?.label).toContain('✨ feat: add the status rollup');
    });
});

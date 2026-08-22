import type { ProjectStatusRepository } from 'caxri';
import { describe, expect, it } from 'vitest';

import { buildRepoChildren } from './status-tree';

describe('Status extension tree', () => {
    it('preserves the pre-extension Status hierarchy and semantic icons', () => {
        const repo: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'primary',
            name: 'lobehub-cloud',
            branch: 'main',
            defaultBranch: 'main',
            branchUrl: 'https://github.com/lobehub/lobehub-cloud/tree/main',
            linearIssues: [],
            deployments: {
                url: 'https://vercel.com/team/project/deployments',
                branchDeployments: [
                    {
                        environment: 'production',
                        hostname: 'production-1.vercel.app',
                        state: 'success',
                        url: 'https://production-1.vercel.app',
                    },
                ],
                production: {
                    environment: 'production',
                    hostname: 'production.vercel.app',
                    state: 'success',
                    url: 'https://production.vercel.app',
                },
            },
            pullRequest: {
                number: 12,
                title: 'Ship Project Status',
                url: 'https://github.com/lobehub/lobehub-cloud/pull/12',
                state: 'failure',
                checks: [{ name: 'Test / App', state: 'failure', durationMs: 125_000 }],
                hiddenCheckCount: 1,
            },
            errors: [],
        };

        const nodes = buildRepoChildren(repo);

        expect(nodes.map(({ item }) => item.label)).toEqual([
            'main',
            'Deployments',
            'Production',
            '#12 Ship Project Status',
        ]);
        expect(nodes[0].item).toMatchObject({ description: 'default' });
        expect(nodes[1].item).toMatchObject({ description: '1 on production' });
        expect(nodes[1].item.iconPath).toMatchObject({ id: 'rocket' });
        expect(nodes[1].children?.[0].item.description).toBeUndefined();
        expect(nodes[1].children?.[0].item.iconPath).toMatchObject({ id: 'circle-check' });
        expect(nodes[2].item).toMatchObject({
            description: 'production.vercel.app',
        });
        expect(nodes[2].item.iconPath).toMatchObject({ id: 'circle-check' });
        expect(nodes[3].item.iconPath).toMatchObject({ id: 'circle-x' });
        expect(nodes[3].children?.map(({ item }) => item.label)).toEqual([
            'Test / App',
            '1 ignored check hidden',
        ]);
        expect(nodes[3].children?.[0].item).toMatchObject({ description: '2m 5s' });
        expect(nodes[3].children?.[0].item.iconPath).toMatchObject({ id: 'circle-x' });
        expect(nodes[3].children?.[1].item.iconPath).toMatchObject({ id: 'eye-off' });
    });
});

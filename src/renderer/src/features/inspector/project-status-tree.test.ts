import { describe, expect, it } from 'vitest';

import type { ProjectStatusRepository } from '@shared/types';

import { buildProjectStatusNodes } from './project-status-tree';

describe('buildProjectStatusNodes', () => {
    it('builds the screenshot-defined branch, Linear, Vercel, and GitHub hierarchy', () => {
        const repository: ProjectStatusRepository = {
            id: 'repo-1',
            kind: 'primary',
            name: 'lobehub-cloud',
            rootPath: '/project',
            branch: 'feature',
            defaultBranch: 'main',
            branchUrl: 'https://github.com/lobehub/lobehub-cloud/tree/feature',
            linearIssues: [
                {
                    identifier: 'LOBE-1',
                    title: 'Fix status panel',
                    state: 'In Progress',
                    stateType: 'started',
                    url: 'https://linear.app/lobehub/issue/LOBE-1',
                },
            ],
            deployments: {
                url: 'https://vercel.com/team/project/deployments',
                branchDeployments: [
                    {
                        environment: 'preview',
                        hostname: 'preview.vercel.app',
                        state: 'success',
                        url: 'https://preview.vercel.app',
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
                state: 'success',
                checks: [
                    {
                        name: 'Test / App',
                        state: 'success',
                        durationMs: 125_000,
                    },
                ],
                hiddenCheckCount: 1,
            },
            errors: [],
        };

        const nodes = buildProjectStatusNodes(repository);

        expect(nodes.map((node) => node.kind)).toEqual([
            'branch',
            'linear',
            'deployments',
            'deployment',
            'pullRequest',
        ]);
        expect(nodes[2]).toMatchObject({ description: '1 on feature' });
        expect(nodes[4]).toMatchObject({
            children: [
                expect.objectContaining({ description: '2m 5s', label: 'Test / App' }),
                expect.objectContaining({ label: '1 ignored check hidden' }),
            ],
        });
    });
});

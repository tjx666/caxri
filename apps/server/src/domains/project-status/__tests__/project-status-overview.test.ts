import type { GitSummary } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ProjectStatusService } from '..';
import { cleanupProjectStatusFixtures, gitSummary, logger } from './project-status.fixture';

afterEach(cleanupProjectStatusFixtures);

/**
 * The status bar's overview read. Split out of `project-status.test.ts`, which covers the Status panel's summary.
 */
describe('ProjectStatusService overview', () => {
    it('loads a lightweight primary repository overview without Linear or Vercel', async () => {
        const summaryWithChanges: GitSummary = {
            ...gitSummary,
            repositories: [
                {
                    ...gitSummary.repositories[0],
                    additions: 2,
                    deletions: 1,
                    files: [
                        {
                            index: ' ',
                            kind: 'modified',
                            path: 'src/status.ts',
                            workingTree: 'M',
                        },
                    ],
                },
            ],
        };
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git') return Promise.resolve('git@github.com:example/project.git\n');
            if (command === 'gh') {
                return Promise.resolve(
                    JSON.stringify({
                        number: 11,
                        title: 'Status Bar context',
                        url: 'https://github.com/example/project/pull/11',
                    }),
                );
            }
            return Promise.reject(
                new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`),
            );
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(summaryWithChanges) },
            await logger(),
            runner,
        );

        const [overview, concurrent] = await Promise.all([
            service.overview('session-1'),
            service.overview('session-1'),
        ]);

        expect(concurrent).toEqual(overview);
        expect(overview.repository).toEqual({
            id: 'repo-1',
            branch: 'feature/status',
            branchUrl: 'https://github.com/example/project/tree/feature%2Fstatus',
            changedFileCount: 1,
            additions: 2,
            deletions: 1,
            pullRequest: {
                number: 11,
                title: 'Status Bar context',
                url: 'https://github.com/example/project/pull/11',
                source: 'branch',
            },
            acceptances: [],
            linearIssues: [],
        });
        expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
        expect(
            runner.mock.calls.some(([command]) => command === 'linear' || command === 'vc'),
        ).toBe(false);
        expect(runner.mock.calls.find(([command]) => command === 'gh')?.[1]).toEqual([
            'pr',
            'view',
            'feature/status',
            '--repo',
            'example/project',
            '--json',
            'number,title,url,state,isDraft,body,statusCheckRollup,baseRefName,headRefName,baseRefOid,headRefOid,mergeCommit,mergedAt,mergeable,mergeStateStatus',
        ]);
    });
});

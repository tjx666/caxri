import type { GitSummary } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ProjectStatusService } from '..';
import {
    checkPayload,
    cleanupProjectStatusFixtures,
    gitSummary,
    logger,
} from './project-status.fixture';

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

    /**
     * The chip reads the same filtered rollup as the sidebar row: an ignored failing check must not paint it red, and a
     * pull request that is not open carries no verdict at all.
     */
    describe('pull request checks', () => {
        async function overviewChecks(
            payload: unknown,
            ignoredChecks: string[] = [],
        ): Promise<string | undefined> {
            const runner = vi.fn<ExternalStatusRunner>((command) =>
                Promise.resolve(
                    command === 'git'
                        ? 'git@github.com:example/project.git\n'
                        : JSON.stringify(payload),
                ),
            );
            const service = new ProjectStatusService(
                { summary: () => Promise.resolve(gitSummary) },
                await logger(),
                runner,
                {
                    settings: () => ({
                        ...defaultAppSettings,
                        'projectStatus.ignoredChecks': ignoredChecks,
                    }),
                },
            );
            return (await service.overview('session-1')).repository?.pullRequest?.checks;
        }
        const failing = { name: 'flaky', conclusion: 'FAILURE', status: 'COMPLETED' };
        const payload = (extra: Record<string, unknown>): unknown => ({
            ...(checkPayload(failing) as Record<string, unknown>),
            ...extra,
        });

        it('aggregates the checks of an open pull request', async () => {
            expect(await overviewChecks(payload({ state: 'OPEN' }))).toBe('failure');
        });

        it('leaves out the checks the user ignores', async () => {
            expect(await overviewChecks(payload({ state: 'OPEN' }), ['flaky'])).toBeUndefined();
        });

        it('reports no verdict when GitHub reported no checks', async () => {
            expect(
                await overviewChecks(payload({ state: 'OPEN', statusCheckRollup: [] })),
            ).toBeUndefined();
        });

        it.each(['MERGED', 'CLOSED'])('reports no verdict for a %s pull request', async (state) => {
            expect(await overviewChecks(payload({ state }))).toBeUndefined();
        });
    });
});

import type { ProjectStatusRepository } from '@caxri/protocol';
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

describe('ProjectStatusService review threads', () => {
    it('attaches unresolved review threads to an open pull request only', async () => {
        const runnerFor = (lifecycle: string) =>
            vi.fn<ExternalStatusRunner>((command, arguments_) => {
                if (command === 'git' && arguments_[0] === 'remote')
                    return Promise.resolve('git@github.com:example/project.git\n');
                if (command === 'git') return Promise.resolve('');
                if (command === 'gh' && arguments_.some((value) => value.includes('reviewThreads')))
                    return Promise.resolve(
                        JSON.stringify({
                            data: {
                                repository: {
                                    pullRequest: {
                                        reviewThreads: {
                                            nodes: [
                                                {
                                                    isResolved: false,
                                                    isOutdated: false,
                                                    path: 'src/app.ts',
                                                    line: 3,
                                                    comments: {
                                                        nodes: [
                                                            {
                                                                body: 'Rename this.',
                                                                url: 'https://github.com/example/project/pull/7#discussion_r1',
                                                            },
                                                        ],
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                },
                            },
                        }),
                    );
                if (command === 'gh' && arguments_[0] === 'api')
                    return Promise.resolve(JSON.stringify({ data: { repository: { ref: null } } }));
                if (command === 'gh')
                    return Promise.resolve(
                        JSON.stringify({
                            ...(checkPayload({ name: 'ci', conclusion: 'SUCCESS' }) as object),
                            state: lifecycle,
                        }),
                    );
                return Promise.resolve(JSON.stringify({ teams: [] }));
            });
        const summaryFor = async (lifecycle: string) => {
            const runner = runnerFor(lifecycle);
            const service = new ProjectStatusService(
                { summary: () => Promise.resolve(gitSummary) },
                await logger(),
                runner,
            );
            let pullRequest: ProjectStatusRepository['pullRequest'];
            await vi.waitFor(async () => {
                pullRequest = (await service.summary('session-1')).repositories[0]?.pullRequest;
                expect(pullRequest).toBeDefined();
            });
            return { pullRequest, runner };
        };

        const open = await summaryFor('OPEN');
        expect(open.pullRequest).toMatchObject({
            unresolvedReviewThreads: [
                {
                    url: 'https://github.com/example/project/pull/7#discussion_r1',
                    body: 'Rename this.',
                    path: 'src/app.ts',
                    line: 3,
                },
            ],
        });

        const merged = await summaryFor('MERGED');
        expect(merged.pullRequest).not.toHaveProperty('unresolvedReviewThreads');
        expect(
            vi
                .mocked(merged.runner)
                .mock.calls.some(([, arguments_]) =>
                    arguments_.some((value) => value.includes('reviewThreads')),
                ),
        ).toBe(false);
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import type { GitSummary } from '../../shared/types';
import {
    extractLinearReferences,
    parseGitHubPullRequest,
    parseGitHubRemote,
    ProjectStatusService,
    type ProjectStatusRunner,
} from '../project-status';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function logger(): Promise<StructuredLogger> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-status-'));
    temporaryDirectories.push(directory);
    return new StructuredLogger(directory);
}

const gitSummary: GitSummary = {
    isRepository: true,
    repositories: [
        {
            id: 'repo-1',
            kind: 'primary',
            name: 'project',
            rootPath: '/project',
            branch: 'feature/status',
            head: '1234567',
            ahead: 0,
            behind: 0,
            files: [],
        },
    ],
};

describe('ProjectStatusService', () => {
    it('loads a lightweight primary repository overview without Linear or Vercel', async () => {
        const summaryWithChanges: GitSummary = {
            ...gitSummary,
            repositories: [
                {
                    ...gitSummary.repositories[0],
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
        const runner = vi.fn<ProjectStatusRunner>((command, args) => {
            if (command === 'git') return Promise.resolve('git@github.com:lobehub/project.git\n');
            if (command === 'gh') {
                return Promise.resolve(
                    JSON.stringify({
                        number: 11,
                        title: 'Status Bar context',
                        url: 'https://github.com/lobehub/project/pull/11',
                    }),
                );
            }
            return Promise.reject(new Error(`Unexpected command: ${command} ${args.join(' ')}`));
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
            branch: 'feature/status',
            branchUrl: 'https://github.com/lobehub/project/tree/feature%2Fstatus',
            changedFileCount: 1,
            pullRequest: {
                number: 11,
                title: 'Status Bar context',
                url: 'https://github.com/lobehub/project/pull/11',
            },
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
            'lobehub/project',
            '--json',
            'number,title,url',
        ]);
    });

    it('assembles GitHub, Linear, and Vercel status with structured CLI arguments', async () => {
        const runner = vi.fn<ProjectStatusRunner>((command, args) => {
            if (command === 'git' && args[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git' && args[0] === 'symbolic-ref') {
                return Promise.resolve('origin/main\n');
            }
            if (command === 'git' && args[0] === 'rev-parse') {
                return Promise.resolve('1234567890abcdef\n');
            }
            if (command === 'gh') {
                return Promise.resolve(
                    JSON.stringify({
                        body: 'Fixes LOBE-42',
                        number: 7,
                        title: 'Ship status panel',
                        url: 'https://github.com/lobehub/project/pull/7',
                        statusCheckRollup: [
                            {
                                conclusion: 'SUCCESS',
                                name: 'App',
                                status: 'COMPLETED',
                                workflowName: 'Test',
                            },
                        ],
                    }),
                );
            }
            if (command === 'linear') {
                return Promise.resolve(
                    JSON.stringify({
                        data: {
                            issue: {
                                identifier: 'LOBE-42',
                                title: 'Project Status',
                                url: 'https://linear.app/lobehub/issue/LOBE-42',
                                state: { name: 'In Progress', type: 'started' },
                            },
                        },
                    }),
                );
            }
            if (command === 'vc' && args[0] === 'teams') {
                return Promise.resolve(JSON.stringify({ teams: [{ slug: 'lobehub' }] }));
            }
            if (command === 'vc' && args.includes('--environment')) {
                const environment = args.at(args.indexOf('--environment') + 1);
                return Promise.resolve(
                    JSON.stringify([
                        {
                            name: 'project',
                            readyState: 'READY',
                            target: environment,
                            url: `${environment}.vercel.app`,
                        },
                    ]),
                );
            }
            if (command === 'vc' && args.some((value) => value.includes('githubCommitRef='))) {
                return Promise.resolve(
                    JSON.stringify([
                        {
                            name: 'project',
                            readyState: 'BUILDING',
                            target: 'preview',
                            url: 'branch.vercel.app',
                        },
                    ]),
                );
            }
            if (command === 'vc') {
                return Promise.resolve(
                    JSON.stringify([{ name: 'project', url: 'discovery.vercel.app' }]),
                );
            }
            return Promise.reject(new Error(`Unexpected command: ${command} ${args.join(' ')}`));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
        );

        const [summary, concurrent] = await Promise.all([
            service.summary('session-1'),
            service.summary('session-1'),
        ]);

        expect(concurrent).toEqual(summary);
        const repository = summary.repositories[0];
        expect(repository).toMatchObject({
            name: 'project',
            branch: 'feature/status',
            defaultBranch: 'main',
            pullRequest: {
                number: 7,
                state: 'success',
                checks: [{ name: 'Test / App', state: 'success' }],
            },
            linearIssues: [
                {
                    identifier: 'LOBE-42',
                    title: 'Project Status',
                    state: 'In Progress',
                    stateType: 'started',
                },
            ],
            errors: [],
        });
        expect(repository.deployments?.branchDeployments[0]).toMatchObject({ state: 'pending' });
        expect(repository.deployments?.production).toMatchObject({ environment: 'production' });
        expect(repository.deployments?.preview).toMatchObject({ environment: 'preview' });
        expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
        expect(runner.mock.calls.find(([command]) => command === 'linear')?.[1]).toContain(
            'id=LOBE-42',
        );
    });

    it('keeps repositories visible when integrations fail', async () => {
        const runner: ProjectStatusRunner = (command, args) => {
            if (command === 'git' && args[0] === 'remote') {
                return Promise.resolve('https://github.com/lobehub/project.git');
            }
            if (command === 'git') return Promise.resolve('');
            return Promise.reject(new Error(`${command} unavailable`));
        };
        const summary = await new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
        ).summary('session-1');

        expect(summary.repositories[0]).toMatchObject({
            branch: 'feature/status',
            errors: [
                expect.objectContaining({ source: 'github' }),
                expect.objectContaining({ source: 'vercel' }),
            ],
        });
    });
});

describe('Project Status parsers', () => {
    it('accepts HTTPS and SSH GitHub remotes', () => {
        expect(parseGitHubRemote('git@github.com:lobehub/caxri.git')).toEqual({
            owner: 'lobehub',
            repo: 'caxri',
        });
        expect(parseGitHubRemote('https://github.com/lobehub/caxri')).toEqual({
            owner: 'lobehub',
            repo: 'caxri',
        });
    });

    it('extracts deliberate Linear references without treating bare mentions as links', () => {
        expect(
            extractLinearReferences(
                'Follow-up LOBE-1\nFixes LOBE-2, LOBE-3\nhttps://linear.app/lobehub/issue/LOBE-4/title',
            ),
        ).toEqual([
            { identifier: 'LOBE-4', workspace: 'lobehub' },
            { identifier: 'LOBE-2', workspace: undefined },
            { identifier: 'LOBE-3', workspace: undefined },
        ]);
    });

    it('maps failed checks ahead of successful checks', () => {
        expect(
            parseGitHubPullRequest(
                JSON.stringify({
                    number: 1,
                    title: 'PR',
                    url: 'https://github.com/a/b/pull/1',
                    statusCheckRollup: [
                        { conclusion: 'SUCCESS', name: 'pass' },
                        { conclusion: 'FAILURE', name: 'fail' },
                    ],
                }),
            ).pullRequest,
        ).toMatchObject({ state: 'failure', checks: [{ name: 'fail' }, { name: 'pass' }] });
    });
});

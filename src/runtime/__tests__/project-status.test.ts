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
} from '../project-status';
import type { ProjectStatusRunner, VercelLink } from '../project-status-external';
import { rememberVercelLink } from '../project-status-external';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    const pendingLoggers = loggers.slice();
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((instance) => instance.flush()));
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function logger(): Promise<StructuredLogger> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-status-'));
    temporaryDirectories.push(directory);
    const instance = new StructuredLogger(directory);
    loggers.push(instance);
    return instance;
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
            additions: 0,
            deletions: 0,
            generation: 0,
            changedFileCount: 0,
            truncated: false,
            files: [],
        },
    ],
};

describe('ProjectStatusService', () => {
    it('returns local status before a slow external CLI refresh completes', async () => {
        const external = Promise.withResolvers<string>();
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            return external.promise;
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                emit: (event) => {
                    if (event.event === 'projectStatus.changed') refreshed.resolve();
                },
            },
        );

        const summary = await service.summary('session-1');
        expect(summary.repositories[0]?.branch).toBe('feature/status');
        expect(summary.repositories[0]?.pullRequest).toBeUndefined();

        external.resolve(
            JSON.stringify({
                number: 7,
                title: 'Ship status panel',
                url: 'https://github.com/lobehub/project/pull/7',
            }),
        );
        await refreshed.promise;
        const cached = await service.summary('session-1');

        expect(cached.repositories[0]).toMatchObject({ pullRequest: { number: 7 } });
    });

    it('uses a refresh token to bypass a fresh cache exactly once', async () => {
        let pullRequestNumber = 7;
        const forcedGithub = Promise.withResolvers<string>();
        const emitted = vi.fn();
        const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') {
                if (pullRequestNumber === 8) return forcedGithub.promise;
                return Promise.resolve(
                    JSON.stringify({
                        number: pullRequestNumber,
                        title: `Pull request ${pullRequestNumber}`,
                        url: `https://github.com/lobehub/project/pull/${pullRequestNumber}`,
                    }),
                );
            }
            return Promise.resolve(JSON.stringify({ teams: [] }));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            { emit: emitted },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(1));
        expect((await service.summary('session-1')).repositories[0]?.pullRequest?.number).toBe(7);

        pullRequestNumber = 8;
        let isForcedSettled = false;
        const forced = service.summary('session-1', 'refresh-1');
        const observeForcedSettlement = async (): Promise<void> => {
            await forced;
            isForcedSettled = true;
        };
        const forcedSettlement = observeForcedSettlement();
        await vi.waitFor(() =>
            expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(2),
        );
        expect(isForcedSettled).toBe(false);
        forcedGithub.resolve(
            JSON.stringify({
                number: 8,
                title: 'Pull request 8',
                url: 'https://github.com/lobehub/project/pull/8',
            }),
        );
        await forcedSettlement;
        expect((await forced).repositories[0]?.pullRequest?.number).toBe(8);
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2));
        expect(
            (await service.summary('session-1', 'refresh-1')).repositories[0]?.pullRequest?.number,
        ).toBe(8);
        const externalCalls = runner.mock.calls.filter(([command]) => command !== 'git').length;

        await service.summary('session-1', 'refresh-1');
        expect(runner.mock.calls.filter(([command]) => command !== 'git')).toHaveLength(
            externalCalls,
        );
    });

    it('discards a background refresh after its Session is evicted', async () => {
        const externalStarted = Promise.withResolvers<void>();
        const external = Promise.withResolvers<string>();
        const emitted = vi.fn();
        const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') {
                externalStarted.resolve();
                return external.promise;
            }
            return Promise.resolve(JSON.stringify({ teams: [] }));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            { emit: emitted },
        );

        const refresh = service.summary('session-1', 'refresh-before-delete');
        await externalStarted.promise;
        service.evictSessions(['session-1']);
        external.resolve(
            JSON.stringify({
                number: 9,
                title: 'Late pull request',
                url: 'https://github.com/lobehub/project/pull/9',
            }),
        );

        expect((await refresh).repositories[0]?.pullRequest).toBeUndefined();
        expect(emitted).not.toHaveBeenCalled();
    });

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
        const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
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
            branchUrl: 'https://github.com/lobehub/project/tree/feature%2Fstatus',
            changedFileCount: 1,
            additions: 2,
            deletions: 1,
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
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git' && arguments_[0] === 'symbolic-ref') {
                return Promise.resolve('origin/main\n');
            }
            if (command === 'git' && arguments_[0] === 'rev-parse') {
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
            if (command === 'vc' && arguments_[0] === 'teams') {
                return Promise.resolve(JSON.stringify({ teams: [{ slug: 'lobehub' }] }));
            }
            if (command === 'vc' && arguments_.includes('--environment')) {
                const environment = arguments_.at(arguments_.indexOf('--environment') + 1);
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
            if (
                command === 'vc' &&
                arguments_.some((value) => value.includes('githubCommitRef='))
            ) {
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
            return Promise.reject(
                new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`),
            );
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                emit: (event) => {
                    if (event.event === 'projectStatus.changed') refreshed.resolve();
                },
            },
        );

        const [local, concurrent] = await Promise.all([
            service.summary('session-1'),
            service.summary('session-1'),
        ]);
        expect(concurrent).toEqual(local);
        expect(local.repositories[0]?.pullRequest).toBeUndefined();
        await refreshed.promise;
        const summary = await service.summary('session-1');

        const repo = summary.repositories[0];
        expect(repo).toMatchObject({
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
        expect(repo.deployments?.branchDeployments[0]).toMatchObject({ state: 'pending' });
        expect(repo.deployments?.production).toMatchObject({ environment: 'production' });
        expect(repo.deployments?.preview).toMatchObject({ environment: 'preview' });
        expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
        expect(runner.mock.calls.find(([command]) => command === 'linear')?.[1]).toContain(
            'id=LOBE-42',
        );
    });

    it('keeps repositories visible when integrations fail', async () => {
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ProjectStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('https://github.com/lobehub/project.git');
            }
            if (command === 'git') return Promise.resolve('');
            return Promise.reject(new Error(`${command} unavailable`));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                emit: (event) => {
                    if (event.event === 'projectStatus.changed') refreshed.resolve();
                },
            },
        );

        const local = await service.summary('session-1');
        expect(local.repositories[0]?.errors).toEqual([]);
        await refreshed.promise;
        const externalCalls = runner.mock.calls.filter(([command]) => command !== 'git').length;
        const summary = await service.summary('session-1');
        const cached = await service.summary('session-1');

        expect(summary.repositories[0]).toMatchObject({
            branch: 'feature/status',
            errors: [
                expect.objectContaining({ source: 'github' }),
                expect.objectContaining({ source: 'vercel' }),
            ],
        });
        expect(cached).toEqual(summary);
        expect(runner.mock.calls.filter(([command]) => command !== 'git')).toHaveLength(
            externalCalls,
        );
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

    it('bounds the vercelLinks cache under many distinct keys, evicting least-recently-used entries', () => {
        const links = new Map<string, VercelLink>();
        const maximum = 256;
        for (let index = 0; index < maximum + 50; index += 1) {
            rememberVercelLink(
                links,
                `owner/repo-${index}`,
                { team: 'team', project: `project-${index}` },
                maximum,
            );
        }
        expect(links.size).toBe(maximum);
        // The earliest-inserted keys should have been evicted first.
        expect(links.has('owner/repo-0')).toBe(false);
        expect(links.has('owner/repo-49')).toBe(false);
        expect(links.has(`owner/repo-${maximum + 49}`)).toBe(true);
    });

    it('rejects malformed GitHub pull request JSON as VALIDATION', () => {
        expect(() => parseGitHubPullRequest('{')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() => parseGitHubPullRequest(JSON.stringify({ number: '11', title: 2 }))).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
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

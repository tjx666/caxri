import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitSummary } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { LinearIssueStore } from '../../external-status';
import type { SessionTranscriptContext } from '../../session-context';
import { ProjectStatusService } from '..';
import { loadOverviewLinearIssues } from '../linear';

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
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-status-linear-'));
    temporaryDirectories.push(directory);
    const instance = new StructuredLogger(directory);
    loggers.push(instance);
    return instance;
}

function gitSummary(branch: string): GitSummary {
    return {
        isRepository: true,
        repositories: [
            {
                id: 'repo-1',
                kind: 'primary',
                name: 'project',
                rootPath: '/project',
                branch,
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
}

const EMPTY_CONTEXT: SessionTranscriptContext = {
    acceptanceReferences: [],
    branches: [],
    directories: [],
    linearReferences: [],
    pullRequests: {},
};

function runner(pullRequestBody = '') {
    return vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git' && arguments_[0] === 'remote')
            return Promise.resolve('git@github.com:example/project.git\n');
        if (command === 'git') return Promise.resolve('');
        if (command === 'gh')
            return Promise.resolve(
                JSON.stringify({
                    number: 11,
                    title: 'Status Bar context',
                    url: 'https://github.com/example/project/pull/11',
                    body: pullRequestBody,
                }),
            );
        if (command === 'linear') {
            const query = arguments_[1] ?? '';
            if (query.includes('TeamKeys'))
                return Promise.resolve(
                    JSON.stringify({ data: { teams: { nodes: [{ key: 'ABC' }] } } }),
                );
            return Promise.resolve(
                JSON.stringify({
                    data: {
                        issue: {
                            identifier: 'ABC-42',
                            title: 'Router monitoring',
                            url: 'https://linear.app/acme/issue/ABC-42',
                            state: { name: 'In Progress', type: 'started', color: '#5E6AD2' },
                        },
                    },
                }),
            );
        }
        return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
}

async function service(
    branch: string,
    options: { body?: string; context?: SessionTranscriptContext } = {},
) {
    const run = runner(options.body);
    return {
        run,
        status: new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary(branch)) },
            await logger(),
            run,
            {
                sessionContext: () => Promise.resolve(options.context ?? EMPTY_CONTEXT),
            },
        ),
    };
}

describe('status bar Linear issues', () => {
    it('resolves the leading issue a branch name names, once the team key is allow-listed', async () => {
        const { run, status } = await service('feat/abc-42-router');
        const overview = await status.overview('session-1');
        expect(overview.repository?.linearIssues).toEqual([
            {
                identifier: 'ABC-42',
                title: 'Router monitoring',
                url: 'https://linear.app/acme/issue/ABC-42',
                state: 'In Progress',
                stateType: 'started',
                stateColor: '#5E6AD2',
                source: 'branch',
            },
        ]);
        // One allow-list query plus one issue query — and no second `gh` call, because the pull request record the
        // overview already fetched carries the body.
        expect(run.mock.calls.filter(([command]) => command === 'linear')).toHaveLength(2);
        expect(run.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
    });

    it('prefers what the pull request description states, and skips the allow-list entirely', async () => {
        const { run, status } = await service('feature/status', {
            body: 'Fixes https://linear.app/acme/issue/ABC-42',
        });
        const overview = await status.overview('session-1');
        expect(overview.repository?.linearIssues[0]).toMatchObject({
            identifier: 'ABC-42',
            source: 'pull-request',
        });
        expect(
            run.mock.calls.some(
                ([command, arguments_]) =>
                    command === 'linear' && (arguments_[1] ?? '').includes('TeamKeys'),
            ),
        ).toBe(false);
    });

    it('reads the conversation when neither the pull request nor the branch says anything', async () => {
        const { status } = await service('feature/status', {
            context: { ...EMPTY_CONTEXT, linearReferences: [{ identifier: 'ABC-42' }] },
        });
        const overview = await status.overview('session-1');
        expect(overview.repository?.linearIssues[0]).toMatchObject({
            identifier: 'ABC-42',
            source: 'conversation',
        });
    });

    it('rejects a conversation marker whose team key the workspace does not define', async () => {
        const { status } = await service('feature/status', {
            context: { ...EMPTY_CONTEXT, linearReferences: [{ identifier: 'RFC-2119' }] },
        });
        const overview = await status.overview('session-1');
        expect(overview.repository?.linearIssues).toEqual([]);
    });

    it('degrades to the bare identifier when the issue cannot be resolved', async () => {
        const run = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote')
                return Promise.resolve('git@github.com:example/project.git\n');
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') return Promise.reject(new Error('no pull requests found'));
            if (command === 'linear' && (arguments_[1] ?? '').includes('TeamKeys'))
                return Promise.resolve(
                    JSON.stringify({ data: { teams: { nodes: [{ key: 'ABC' }] } } }),
                );
            return Promise.reject(new Error('linear: command not found'));
        });
        const status = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary('feat/abc-42-router')) },
            await logger(),
            run,
        );
        const overview = await status.overview('session-1');
        expect(overview.repository?.linearIssues).toEqual([
            { identifier: 'ABC-42', source: 'branch' },
        ]);
    });

    it('draws the bare identifier when Linear misses the deadline, then the resolved issue once it lands', async () => {
        const issueAnswer = Promise.withResolvers<string>();
        const answerIssue = issueAnswer.resolve;
        const run = vi.fn((arguments_: readonly string[]) =>
            (arguments_[1] ?? '').includes('TeamKeys')
                ? Promise.resolve(JSON.stringify({ data: { teams: { nodes: [{ key: 'ABC' }] } } }))
                : issueAnswer.promise,
        );
        const store = new LinearIssueStore(run);
        const sources = { branch: 'feat/abc-42-router', conversation: [] };

        expect(await loadOverviewLinearIssues(store, '/project', sources, 20)).toEqual([
            { identifier: 'ABC-42', source: 'branch' },
        ]);

        answerIssue(
            JSON.stringify({
                data: {
                    issue: {
                        identifier: 'ABC-42',
                        title: 'Router monitoring',
                        url: 'https://linear.app/acme/issue/ABC-42',
                        state: { name: 'In Progress', type: 'started', color: '#5E6AD2' },
                    },
                },
            }),
        );
        await vi.waitFor(async () =>
            expect(
                (await loadOverviewLinearIssues(store, '/project', sources, 20))[0],
            ).toMatchObject({ title: 'Router monitoring', source: 'branch' }),
        );
        expect(run).toHaveBeenCalledTimes(2);
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitSummary } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

/**
 * Flushes the loggers and removes the log directories {@link logger} created; register it with `afterEach`.
 */
export async function cleanupProjectStatusFixtures(): Promise<void> {
    const pendingLoggers = loggers.slice();
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((instance) => instance.flush()));
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
}

export async function logger(): Promise<StructuredLogger> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-status-'));
    temporaryDirectories.push(directory);
    const instance = new StructuredLogger(directory);
    loggers.push(instance);
    return instance;
}
/**
 * A GitHub fixture that can provide a linked Vercel project for cache timing tests.
 */
export function githubOnlyRunner(
    pullRequest: () => unknown,
    hasLinkedVercel = false,
): ExternalStatusRunner {
    return vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git' && arguments_[0] === 'remote')
            return Promise.resolve('git@github.com:example/project.git\n');
        if (command === 'git') return Promise.resolve('');
        // The branch publication probe; an unpublished branch keeps it off the pull request path under test.
        if (command === 'gh' && arguments_[0] === 'api')
            return Promise.resolve(JSON.stringify({ data: { repository: { ref: null } } }));
        if (command === 'gh') return Promise.resolve(JSON.stringify(pullRequest()));
        if (hasLinkedVercel && command === 'vc') {
            if (arguments_[0] === 'teams')
                return Promise.resolve(JSON.stringify({ teams: [{ slug: 'team' }] }));
            const query = arguments_[1] ?? '';
            if (!query.includes('meta-githubCommit') && !query.includes('target='))
                return Promise.resolve(JSON.stringify([{ name: 'project' }]));
            return Promise.resolve('[]');
        }
        return Promise.resolve(JSON.stringify({ teams: [] }));
    });
}

export function checkPayload(check: Record<string, unknown>): unknown {
    return {
        number: 7,
        title: 'Ship status panel',
        url: 'https://github.com/example/project/pull/7',
        statusCheckRollup: [check],
    };
}

export const gitSummary: GitSummary = {
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

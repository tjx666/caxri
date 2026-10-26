import type { SessionPullRequest } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ProjectStatusService } from '..';
import type { SessionPullRequestResolution } from '../session-pull-request-parse';
import { cleanupProjectStatusFixtures, gitSummary, logger } from './project-status.fixture';

afterEach(cleanupProjectStatusFixtures);

function sessionPullRequest(url: string, number: number): SessionPullRequest {
    return { number, source: 'agent', state: 'open', title: 'Agent delivery', url };
}

function recordFor(arguments_: readonly string[]): string {
    const reference = arguments_[2] ?? '';
    const slug = arguments_[4] ?? '';
    const number = /^\d+$/.test(reference) ? Number(reference) : 7;
    return JSON.stringify({
        number,
        title: `PR ${number}`,
        url: `https://github.com/${slug}/pull/${number}`,
        body: '',
        headRefName: 'feat/delivery',
    });
}

async function service(resolution: SessionPullRequestResolution | undefined) {
    const refreshed = Promise.withResolvers<void>();
    const run = vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git' && arguments_[0] === 'remote')
            return Promise.resolve('git@github.com:example/project.git\n');
        if (command === 'git') return Promise.resolve('');
        if (command === 'gh' && arguments_[1] === 'view')
            return Promise.resolve(recordFor(arguments_));
        return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const status = new ProjectStatusService(
        { summary: () => Promise.resolve(gitSummary) },
        await logger(),
        run,
        {
            emit: (event) => {
                if (event.event === 'projectStatus.changed') refreshed.resolve();
            },
        },
    );
    const resolve = vi.fn(() => Promise.resolve(resolution));
    status.useSessionPullRequests(resolve);
    const views = () =>
        run.mock.calls.filter(
            ([command, arguments_]) => command === 'gh' && arguments_[1] === 'view',
        );
    return { refreshed: refreshed.promise, resolve, status, views };
}

describe('Session pull request in Project Status', () => {
    it('shows the pull request the sidebar row shows, even when it is not the checked-out branch’s', async () => {
        const { status, views } = await service({
            value: sessionPullRequest('https://github.com/example/child/pull/19', 19),
        });

        const overview = await status.overview('session-1');

        expect(overview.repository?.pullRequest).toEqual({
            number: 19,
            title: 'PR 19',
            url: 'https://github.com/example/child/pull/19',
            headBranch: 'feat/delivery',
            source: 'conversation',
        });
        expect(views()).toHaveLength(1);
        expect(views()[0]?.[1]).toEqual(
            expect.arrayContaining(['view', '19', '--repo', 'example/child']),
        );
    });

    it('asks GitHub nothing when the Session has no pull request', async () => {
        const { status, views } = await service({});

        const overview = await status.overview('session-1');

        expect(overview.repository?.pullRequest).toBeUndefined();
        expect(overview.repository?.pullRequestUnavailable).toBeUndefined();
        expect(views()).toHaveLength(0);
    });

    it('reports the Session’s failed lookup instead of repeating it', async () => {
        const unavailable = { reason: 'rate-limited' } as const;
        const { status, views } = await service({ unavailable });

        const overview = await status.overview('session-1');

        expect(overview.repository?.pullRequestUnavailable).toEqual(unavailable);
        expect(views()).toHaveLength(0);
    });

    it('keeps the per-branch lookup for a Session the resolver does not track', async () => {
        const { status, views } = await service(undefined);

        const overview = await status.overview('session-1');

        expect(overview.repository?.pullRequest).toMatchObject({ number: 7, source: 'branch' });
        expect(views()[0]?.[1]).toEqual(expect.arrayContaining(['view', 'feature/status']));
    });

    it('loads the Session’s pull request on its own repository row of the Status panel', async () => {
        const { refreshed, status, views } = await service({
            value: sessionPullRequest('https://github.com/Example/Project/pull/23', 23),
        });

        await status.summary('session-1');
        await refreshed;
        const summary = await status.summary('session-1');

        expect(summary.repositories[0]?.pullRequest).toMatchObject({
            number: 23,
            headBranch: 'feat/delivery',
        });
        expect(views().every(([, arguments_]) => arguments_[2] === '23')).toBe(true);
    });
});

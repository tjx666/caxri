import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubPullRequestStore } from '../../external-status';
import { ProjectStatusService } from '..';
import {
    checkPayload,
    cleanupProjectStatusFixtures,
    githubOnlyRunner,
    gitSummary,
    logger,
} from './project-status.fixture';

afterEach(cleanupProjectStatusFixtures);

const url = 'https://github.com/example/project/pull/7';

async function setup() {
    let state = 'OPEN';
    let changed = 0;
    const runner = githubOnlyRunner(() => ({
        ...(checkPayload({ name: 'unit', conclusion: 'SUCCESS' }) as object),
        state,
    }));
    /**
     * Time never advances, so only `pullRequestChanged` can make the settled snapshot stale.
     */
    const now = () => 1_000_000;
    const github = new GitHubPullRequestStore(runner, { now });
    const service = new ProjectStatusService(
        { summary: () => Promise.resolve(gitSummary) },
        await logger(),
        runner,
        {
            clearTimer: () => {},
            emit: (event) => {
                if (event.event === 'projectStatus.changed') changed += 1;
            },
            github,
            now,
            setTimer: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout,
            settings: () => defaultAppSettings,
        },
    );
    const lifecycle = async () =>
        (await service.summary('session-1')).repositories[0]?.pullRequest?.lifecycle;
    const ghViews = () =>
        vi
            .mocked(runner)
            .mock.calls.filter(
                ([command, arguments_]) => command === 'gh' && arguments_[0] === 'pr',
            ).length;
    /**
     * What the sidebar sweep does when it sees the merge: refetch the shared record past its TTL.
     */
    const sweepSees = async (next: string) => {
        state = next;
        await github.view({
            cwd: '/project',
            maxAgeMs: 0,
            number: 7,
            owner: 'example',
            repo: 'project',
        });
    };
    await service.summary('session-1');
    await vi.waitFor(() => expect(changed).toBe(1));
    return { changed: () => changed, ghViews, lifecycle, service, sweepSees };
}

describe('ProjectStatusService.pullRequestChanged', () => {
    it('re-reads a visible Session from the record the sweep just fetched', async () => {
        const { changed, ghViews, lifecycle, service, sweepSees } = await setup();
        service.setPolledSessions(new Set(['session-1']));
        expect(await lifecycle()).toBe('open');

        await sweepSees('MERGED');
        const views = ghViews();
        void service.pullRequestChanged('session-1', { state: 'merged', url });

        await vi.waitFor(() => expect(changed()).toBe(2));
        expect(await lifecycle()).toBe('merged');
        // The re-read joined the sweep's record instead of spending another `gh pr view`.
        expect(ghViews()).toBe(views);
    });

    it('leaves a Session nobody renders, or a snapshot that already shows the change, alone', async () => {
        const { changed, lifecycle, service, sweepSees } = await setup();
        await sweepSees('MERGED');

        // Not polled: no panel renders it.
        expect(service.pullRequestChanged('session-1', { state: 'merged', url })).toBeUndefined();
        // Polled, but the snapshot already reports this lifecycle.
        service.setPolledSessions(new Set(['session-1']));
        expect(service.pullRequestChanged('session-1', { state: 'open', url })).toBeUndefined();

        expect(changed()).toBe(1);
        expect(await lifecycle()).toBe('open');
    });
});

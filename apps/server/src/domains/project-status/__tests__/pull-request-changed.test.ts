import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
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
    const payload = (lifecycle: string) => ({
        ...(checkPayload({ name: 'unit', conclusion: 'SUCCESS' }) as object),
        state: lifecycle,
    });
    const base = githubOnlyRunner(() => payload(state));
    /**
     * When armed, the next `gh pr view` reads the state at issue time but answers only once released: a query that was
     * already in flight when the pull request merged.
     */
    let held: { release: () => void } | undefined;
    let isHoldNext = false;
    const runner = vi.fn<ExternalStatusRunner>(async (command, arguments_, cwd) => {
        if (isHoldNext && command === 'gh' && arguments_[0] === 'pr') {
            isHoldNext = false;
            const issuedState = state;
            const gate = Promise.withResolvers<void>();
            held = { release: () => gate.resolve() };
            await gate.promise;
            return JSON.stringify(payload(issuedState));
        }
        return base(command, arguments_, cwd);
    });
    /**
     * Time only advances when a test says so, so otherwise only `pullRequestChanged` can make the settled snapshot
     * stale.
     */
    let time = 1_000_000;
    const now = () => time;
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
    /**
     * Lets the settled snapshot and the shared record expire, then starts an automatic refresh whose `gh pr view` is
     * held open until {@link releaseHeld}.
     */
    const startStaleRefresh = async () => {
        time += 5 * 60_000;
        isHoldNext = true;
        await service.summary('session-1');
        await vi.waitFor(() => expect(held).toBeDefined());
    };
    const releaseHeld = () => held?.release();
    return {
        changed: () => changed,
        ghViews,
        lifecycle,
        /**
         * Merges the pull request on GitHub without telling any Caxri reader.
         */
        merge: () => {
            state = 'MERGED';
        },
        releaseHeld,
        service,
        startStaleRefresh,
        sweepSees,
    };
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

    it('shows the merge even when an automatic refresh issued before it settles last', async () => {
        const { lifecycle, releaseHeld, service, startStaleRefresh, sweepSees } = await setup();
        service.setPolledSessions(new Set(['session-1']));
        await startStaleRefresh();

        await sweepSees('MERGED');
        const reread = service.pullRequestChanged('session-1', { state: 'merged', url });
        releaseHeld();
        await reread;

        await vi.waitFor(async () => expect(await lifecycle()).toBe('merged'));
    });

    it('answers an explicit refresh with the merge instead of joining an older automatic refresh', async () => {
        const { merge, releaseHeld, service, startStaleRefresh } = await setup();
        await startStaleRefresh();
        merge();

        const forced = service.summary('session-1', 'refresh-after-merge');
        releaseHeld();

        expect((await forced).repositories[0]?.pullRequest?.lifecycle).toBe('merged');
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

import type { SessionPullRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MergeNoticeOutcome } from '../merge-notice';
import { PullRequestSettlement } from '../settlement';

const URL = 'https://github.com/acme/widget/pull/42';

function pullRequest(
    state: SessionPullRequest['state'],
    extra: Partial<SessionPullRequest> = {},
): SessionPullRequest {
    return { number: 42, title: 'Widget', url: URL, state, source: 'agent', ...extra };
}

function harness(options: {
    archiveEnabled?: boolean;
    agentState?: string;
    notice?: MergeNoticeOutcome;
    backgroundWork?: boolean;
    openPullRequests?: Record<string, string>;
}) {
    const clock = { now: 1_000_000 };
    const session = {
        archivedAt: undefined as number | undefined,
        agentActivityState: options.agentState ?? 'idle',
    };
    const archive = vi.fn(() => Promise.resolve());
    const notifyMerged = vi.fn(() => Promise.resolve(options.notice ?? 'sent'));
    const write = vi.fn();
    const onArchived = vi.fn();
    const state = {
        archiveEnabled: options.archiveEnabled ?? true,
        backgroundWork: options.backgroundWork ?? false,
    };
    const store: { openPullRequests?: Record<string, string> } = {
        openPullRequests: options.openPullRequests,
    };
    const settlement = new PullRequestSettlement({
        archive,
        backgroundRecheckMs: 30_000,
        database: {
            getAppState: () => store.openPullRequests,
            getSession: () => session,
            setAppState: (_key: string, value: Record<string, string>) => {
                store.openPullRequests = value;
            },
        } as never,
        hasBackgroundWork: () => state.backgroundWork,
        isAutoArchiveEnabled: () => state.archiveEnabled,
        logger: { write },
        onArchived,
        notifyMerged,
        now: () => clock.now,
        turnGraceMs: 20_000,
    });
    const outcomes = () =>
        write.mock.calls.map((call) => (call[2] as { fields: { outcome: string } }).fields.outcome);
    return {
        archive,
        clock,
        notifyMerged,
        onArchived,
        outcomes,
        session,
        settlement,
        state,
        store,
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PullRequestSettlement', () => {
    it('ignores a pull request that was already merged when Caxri first saw it', async () => {
        const { archive, notifyMerged, settlement } = harness({});

        settlement.observePullRequest('s', undefined, pullRequest('merged'));
        await flush();

        expect(notifyMerged).not.toHaveBeenCalled();
        expect(archive).not.toHaveBeenCalled();
    });

    describe('startup reconcile', () => {
        it('notifies once and archives a pull request merged while Caxri was closed', async () => {
            const { archive, notifyMerged, outcomes, settlement, store } = harness({
                notice: 'disabled',
                openPullRequests: { s: URL },
            });

            settlement.observePullRequest('s', undefined, pullRequest('merged', { mergedAt: 9 }));
            // A later sweep reporting the same settled state is not a second transition.
            settlement.observePullRequest('s', pullRequest('merged'), pullRequest('merged'));
            await flush();

            expect(notifyMerged).toHaveBeenCalledExactlyOnceWith('s', URL, {
                origin: 'detected',
                mergedAt: 9,
            });
            expect(archive).toHaveBeenCalledExactlyOnceWith('s');
            expect(outcomes()).toEqual(['recovered', 'archived']);
            expect(store.openPullRequests).toEqual({});
        });

        it('archives a pull request closed while Caxri was closed without any notice', async () => {
            const { archive, notifyMerged, settlement } = harness({
                openPullRequests: { s: URL },
            });

            settlement.observePullRequest('s', undefined, pullRequest('closed'));
            await flush();

            expect(notifyMerged).not.toHaveBeenCalled();
            expect(archive).toHaveBeenCalledWith('s');
        });

        it('defers the archive while the Agent is busy, like a live settlement', async () => {
            const { archive, settlement } = harness({
                agentState: 'running',
                openPullRequests: { s: URL },
            });

            settlement.observePullRequest('s', undefined, pullRequest('closed'));
            await flush();

            expect(archive).not.toHaveBeenCalled();
        });

        it('leaves old settled work alone and drops a record for another pull request', async () => {
            const untracked = harness({});
            untracked.settlement.observePullRequest('s', undefined, pullRequest('merged'));
            const changed = harness({
                openPullRequests: { s: 'https://github.com/acme/widget/pull/1' },
            });
            changed.settlement.observePullRequest('s', undefined, pullRequest('merged'));
            await flush();

            expect(untracked.archive).not.toHaveBeenCalled();
            expect(changed.archive).not.toHaveBeenCalled();
            expect(changed.notifyMerged).not.toHaveBeenCalled();
            expect(changed.store.openPullRequests).toEqual({});
        });

        it('records an open pull request so the next start can recognize its settlement', () => {
            const { settlement, store } = harness({});

            settlement.observePullRequest('s', undefined, pullRequest('open'));
            expect(store.openPullRequests).toEqual({ s: URL });

            settlement.forgetSession('s');
            expect(store.openPullRequests).toEqual({});
        });
    });

    it('tells the Agent about a merge made elsewhere, carrying the merge time', async () => {
        const { notifyMerged, settlement } = harness({});

        settlement.observePullRequest(
            's',
            pullRequest('open'),
            pullRequest('merged', { mergedAt: 7 }),
        );
        await flush();

        expect(notifyMerged).toHaveBeenCalledWith('s', URL, { origin: 'detected', mergedAt: 7 });
    });

    it('reports an automatic archive with the settled state, and only once it happened', async () => {
        const merged = harness({ notice: 'disabled' });
        merged.settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
        await flush();
        expect(merged.onArchived).toHaveBeenCalledExactlyOnceWith('s', 'merged');

        const closed = harness({ notice: 'disabled' });
        closed.settlement.observePullRequest('s', pullRequest('open'), pullRequest('closed'));
        await flush();
        expect(closed.onArchived).toHaveBeenCalledExactlyOnceWith('s', 'closed');

        const busy = harness({ agentState: 'running' });
        busy.settlement.observePullRequest('s', pullRequest('open'), pullRequest('closed'));
        await flush();
        expect(busy.onArchived).not.toHaveBeenCalled();
    });

    it('waits out the notice turn, then archives once the Agent is idle again', async () => {
        const { archive, clock, outcomes, session, settlement } = harness({});

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
        await flush();
        expect(archive).not.toHaveBeenCalled();
        expect(outcomes()).toEqual(['deferred']);

        clock.now += 1000;
        session.agentActivityState = 'running';
        settlement.observeActivity({ sessionId: 's', from: 'idle', to: 'running' });
        await flush();
        expect(archive).not.toHaveBeenCalled();

        session.agentActivityState = 'completed';
        settlement.observeActivity({ sessionId: 's', from: 'running', to: 'completed' });
        await flush();
        expect(archive).toHaveBeenCalledWith('s');
        // The notice-turn wait and the busy turn are two distinct reasons, each logged once.
        expect(outcomes()).toEqual(['deferred', 'deferred', 'archived']);
    });

    it('drops a deferred archive for a forgotten Session so a later activity change cannot archive it', async () => {
        const { archive, outcomes, session, settlement } = harness({});

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
        await flush();
        expect(outcomes()).toEqual(['deferred']);

        settlement.forgetSession('s');
        session.agentActivityState = 'completed';
        settlement.observeActivity({ sessionId: 's', from: 'running', to: 'completed' });
        await flush();

        expect(archive).not.toHaveBeenCalled();
        expect(outcomes()).toEqual(['deferred']);
    });

    it('archives a closed pull request immediately when the Agent is idle, without any notice', async () => {
        const { archive, notifyMerged, settlement } = harness({});

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('closed'));
        await flush();

        expect(notifyMerged).not.toHaveBeenCalled();
        expect(archive).toHaveBeenCalledWith('s');
    });

    it('archives straight away when the merge notice was skipped', async () => {
        const { archive, settlement } = harness({ notice: 'self-merged' });

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
        await flush();

        expect(archive).toHaveBeenCalledWith('s');
    });

    it('never archives while the Agent is running or waiting on the user', async () => {
        const { archive, outcomes, session, settlement } = harness({
            agentState: 'running',
            notice: 'self-merged',
        });

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
        await flush();
        expect(archive).not.toHaveBeenCalled();

        session.agentActivityState = 'waiting';
        settlement.observeActivity({ sessionId: 's', from: 'running', to: 'waiting' });
        await flush();
        expect(archive).not.toHaveBeenCalled();
        expect(outcomes()).toEqual(['deferred']);
    });

    it('keeps a Session whose turn ended while a background shell or subagent still runs', async () => {
        vi.useFakeTimers();
        try {
            const { archive, outcomes, settlement, state } = harness({
                backgroundWork: true,
                notice: 'self-merged',
            });
            settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
            await vi.advanceTimersByTimeAsync(0);
            expect(archive).not.toHaveBeenCalled();

            // Still watching on the next recheck: no archive and no second log line.
            await vi.advanceTimersByTimeAsync(30_000);
            expect(archive).not.toHaveBeenCalled();
            expect(outcomes()).toEqual(['deferred']);

            // The background work finished without any activity change; the recheck still archives.
            state.backgroundWork = false;
            await vi.advanceTimersByTimeAsync(30_000);
            expect(archive).toHaveBeenCalledWith('s');
            expect(outcomes()).toEqual(['deferred', 'archived']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does nothing when the setting is off, and says so', async () => {
        const { archive, outcomes, settlement } = harness({ archiveEnabled: false });

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('closed'));
        await flush();

        expect(archive).not.toHaveBeenCalled();
        expect(outcomes()).toEqual(['disabled']);
    });

    it('drops a deferred archive when the pull request is reopened', async () => {
        const { archive, outcomes, session, settlement } = harness({ agentState: 'running' });

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('closed'));
        settlement.observePullRequest('s', pullRequest('closed'), pullRequest('open'));
        session.agentActivityState = 'completed';
        settlement.observeActivity({ sessionId: 's', from: 'running', to: 'completed' });
        await flush();

        expect(archive).not.toHaveBeenCalled();
        expect(outcomes()).toEqual(['deferred', 'reopened']);
    });

    it('archives after the grace period when the notice never started a turn', async () => {
        vi.useFakeTimers();
        try {
            const { archive, clock, settlement } = harness({});
            settlement.observePullRequest('s', pullRequest('open'), pullRequest('merged'));
            await vi.advanceTimersByTimeAsync(0);
            expect(archive).not.toHaveBeenCalled();

            clock.now += 21_000;
            await vi.advanceTimersByTimeAsync(21_000);
            expect(archive).toHaveBeenCalledWith('s');
        } finally {
            vi.useRealTimers();
        }
    });

    it('logs a failed archive and leaves the Session alone', async () => {
        const { archive, outcomes, settlement } = harness({ notice: 'self-merged' });
        archive.mockRejectedValueOnce(new Error('boom'));

        settlement.observePullRequest('s', pullRequest('open'), pullRequest('closed'));
        await flush();

        expect(outcomes()).toEqual(['failed']);
    });
});

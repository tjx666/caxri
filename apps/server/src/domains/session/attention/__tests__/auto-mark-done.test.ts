import type { SessionRecord } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutoMarkDone, autoMarkDonePolicy, autoMarkDoneReason } from '../auto-mark-done';

const DAY_MS = 24 * 60 * 60_000;
const NOW = 100 * DAY_MS;

const weekPolicy = autoMarkDonePolicy({
    'agentActivity.autoMarkDoneAfterInactivity': '7d',
    'agentActivity.autoMarkDoneOnPullRequestClose': true,
});

const merged = { closedAt: NOW - DAY_MS - 1, state: 'merged' } as const;

function session(overrides: Partial<SessionRecord> = {}) {
    return {
        id: 'session-1',
        agentActivityState: 'completed',
        attentionGeneration: 3,
        hasPendingAttention: true,
        lastAttentionKind: 'finished',
        sessionActivityAt: NOW - DAY_MS,
        ...overrides,
    } as SessionRecord;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('autoMarkDoneReason', () => {
    it('settles a finished Session once its pull request merged or closed', () => {
        const turn = { turnStartedAt: NOW - 2 * DAY_MS };
        expect(autoMarkDoneReason(session(turn), merged, weekPolicy, NOW)).toBe(
            'pull-request-closed',
        );
        expect(
            autoMarkDoneReason(session(turn), { ...merged, state: 'closed' }, weekPolicy, NOW),
        ).toBe('pull-request-closed');
        expect(
            autoMarkDoneReason(
                session(turn),
                { closedAt: undefined, state: 'open' },
                weekPolicy,
                NOW,
            ),
        ).toBeUndefined();
    });

    it('keeps the result of a follow-up turn started after the pull request closed', () => {
        expect(
            autoMarkDoneReason(
                session({ turnStartedAt: merged.closedAt + 1 }),
                merged,
                weekPolicy,
                NOW,
            ),
        ).toBeUndefined();
    });

    it('settles a Session idle for at least the threshold', () => {
        expect(
            autoMarkDoneReason(
                session({ sessionActivityAt: NOW - 7 * DAY_MS }),
                undefined,
                weekPolicy,
                NOW,
            ),
        ).toBe('inactive');
        expect(
            autoMarkDoneReason(
                session({ sessionActivityAt: NOW - 6 * DAY_MS }),
                undefined,
                weekPolicy,
                NOW,
            ),
        ).toBeUndefined();
    });

    it('never settles a Session waiting on the user, running, archived, or already resolved', () => {
        const old = NOW - 30 * DAY_MS;
        for (const overrides of [
            { lastAttentionKind: 'waiting' },
            { agentActivityState: 'waiting' },
            { agentActivityState: 'running' },
            { archivedAt: NOW },
            { hasPendingAttention: false },
        ] as const)
            expect(
                autoMarkDoneReason(
                    session({ ...overrides, sessionActivityAt: old }),
                    merged,
                    weekPolicy,
                    NOW,
                ),
            ).toBeUndefined();
    });

    it('honors each rule being turned off', () => {
        const off = autoMarkDonePolicy({
            'agentActivity.autoMarkDoneAfterInactivity': 'off',
            'agentActivity.autoMarkDoneOnPullRequestClose': false,
        });
        expect(
            autoMarkDoneReason(session({ sessionActivityAt: 0 }), merged, off, NOW),
        ).toBeUndefined();
    });
});

describe('AutoMarkDone', () => {
    it('resolves the current generation in one batch and republishes the rows once', () => {
        vi.useFakeTimers();
        const settled = session({ id: 'merged-one' });
        const waiting = session({ id: 'waiting-one', lastAttentionKind: 'waiting' });
        const settleSessionsAttention = vi.fn(() => ['merged-one']);
        const send = vi.fn();
        const write = vi.fn();
        const sweep = new AutoMarkDone({
            database: {
                attentionMarks: { settle: settleSessionsAttention },
                listVisibleSessions: () => [settled, waiting],
            },
            logger: { write },
            now: () => NOW,
            pullRequest: () => ({ mergedAt: NOW - 2 * DAY_MS, state: 'merged' }),
            send,
            settings: () => ({
                'agentActivity.autoMarkDoneAfterInactivity': '7d',
                'agentActivity.autoMarkDoneOnPullRequestClose': true,
            }),
        });
        vi.advanceTimersByTime(2_000);

        expect(settleSessionsAttention).toHaveBeenCalledExactlyOnceWith([
            { sessionId: 'merged-one', attentionGeneration: 3 },
        ]);
        expect(send).toHaveBeenCalledExactlyOnceWith({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: ['merged-one'], terminalIds: [] },
        });
        expect(write).toHaveBeenCalledWith('info', 'session_attention.auto_mark_done', {
            fields: { inactive: 0, pullRequestClosed: 1, resolved: 1 },
        });
        sweep.dispose();
    });

    it('coalesces a burst of settled pull requests into one sweep', () => {
        vi.useFakeTimers();
        const listVisibleSessions = vi.fn(() => []);
        const sweep = new AutoMarkDone({
            database: { attentionMarks: { settle: vi.fn(() => []) }, listVisibleSessions },
            logger: { write: vi.fn() },
            pullRequest: () => {},
            send: vi.fn(),
            settings: () => ({
                'agentActivity.autoMarkDoneAfterInactivity': '7d',
                'agentActivity.autoMarkDoneOnPullRequestClose': true,
            }),
        });
        sweep.observePullRequest('session-1', { state: 'merged' } as never);
        sweep.observePullRequest('session-1', { state: 'merged' } as never);
        vi.advanceTimersByTime(2_000);
        expect(listVisibleSessions).toHaveBeenCalledTimes(1);
        sweep.dispose();
    });
});

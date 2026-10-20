import { describe, expect, it, vi } from 'vitest';

import {
    DELIVERY_FOCUS_REFRESH_MIN_INTERVAL_MS,
    DeliveryFocusRefresh,
} from '../delivery-focus-refresh';
import {
    createdPullRequestLines,
    harness,
    pullRequestJson,
    session,
} from '../project-status/__tests__/session-pull-requests.fixture';
import { refreshAfterMerge } from '../pull-request';

describe('SessionPullRequestService.refreshSession', () => {
    it('re-reads a pull request whose cached state is still fresh', async () => {
        const clock = { now: 0 };
        let state = 'OPEN';
        const gh = vi.fn(() => Promise.resolve(pullRequestJson({ state })));
        const { emitted, service, setTranscript } = await harness({
            branch: 'main',
            gh,
            now: () => clock.now,
        });
        await setTranscript(createdPullRequestLines);
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('open');

        // Merged in the browser; the open entry is still inside its TTL, so an ordinary sweep keeps it.
        state = 'MERGED';
        clock.now = 10_000;
        await service.refresh();
        expect(gh).toHaveBeenCalledTimes(1);

        await service.refreshSession('session-1');

        expect(gh).toHaveBeenCalledTimes(2);
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('merged');
        expect(emitted).toHaveLength(2);
    });

    it('reuses a shared record another surface fetched moments earlier', async () => {
        const clock = { now: 0 };
        const gh = vi.fn(() => Promise.resolve(pullRequestJson({ state: 'OPEN' })));
        const { service, setTranscript } = await harness({
            branch: 'main',
            gh,
            now: () => clock.now,
        });
        await setTranscript(createdPullRequestLines);
        await service.refresh();
        clock.now = 1_000;

        await service.refreshSession('session-1');

        expect(gh).toHaveBeenCalledTimes(1);
    });
});

describe('DeliveryFocusRefresh', () => {
    async function setup() {
        const clock = { now: 0 };
        const calls: string[] = [];
        const { logger } = await harness({});
        const refresh = new DeliveryFocusRefresh({
            logger,
            now: () => clock.now,
            projectStatus: {
                summary: vi.fn((sessionId: string, refreshToken?: string) => {
                    calls.push(`summary:${sessionId}:${refreshToken ? 'forced' : 'cached'}`);
                    return Promise.resolve({ refreshedAt: 0, repositories: [] });
                }),
            },
            sessionPullRequests: {
                refreshSession: vi.fn((sessionId: string) => {
                    calls.push(`pullRequests:${sessionId}`);
                    return Promise.resolve();
                }),
            },
        });
        return { calls, clock, refresh };
    }

    it('forces the Status panel before the sidebar so the sidebar can share its fetch', async () => {
        const { calls, refresh } = await setup();

        await refresh.request('session-1');

        expect(calls).toEqual(['summary:session-1:forced', 'pullRequests:session-1']);
    });

    it('throttles repeated focus per Session', async () => {
        const { calls, clock, refresh } = await setup();

        await refresh.request('session-1');
        clock.now = DELIVERY_FOCUS_REFRESH_MIN_INTERVAL_MS - 1;
        expect(refresh.request('session-1')).toBeUndefined();
        await refresh.request('session-2');
        clock.now = DELIVERY_FOCUS_REFRESH_MIN_INTERVAL_MS;
        await refresh.request('session-1');

        expect(calls.filter((call) => call.startsWith('summary:'))).toEqual([
            'summary:session-1:forced',
            'summary:session-2:forced',
            'summary:session-1:forced',
        ]);
    });
});

describe('refreshAfterMerge', () => {
    it('re-reads every Session showing the merged pull request while its open entry is still fresh', async () => {
        const clock = { now: 0 };
        let state = 'OPEN';
        const gh = vi.fn((arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[1] === 'list'
                    ? `[${pullRequestJson({ number: 42, state })}]`
                    : pullRequestJson({ number: 42, state }),
            ),
        );
        const { service } = await harness({
            gh,
            now: () => clock.now,
            sessions: [
                session({ primaryAgentTerminalId: 'terminal-1' }),
                session({ id: 'session-2', sidebarOrder: 1 }),
            ],
        });
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']?.state).toBe('open');
        expect(service.snapshot().pullRequests['session-2']?.state).toBe('open');

        // Merged from the Status panel moments later: an ordinary sweep keeps both open entries inside their TTL.
        state = 'MERGED';
        clock.now = 10_000;
        await service.refresh();
        expect(service.snapshot().pullRequests['session-2']?.state).toBe('open');

        await refreshAfterMerge(service, 'session-1', 42);

        expect(service.snapshot().pullRequests['session-1']?.state).toBe('merged');
        expect(service.snapshot().pullRequests['session-2']?.state).toBe('merged');
    });
});

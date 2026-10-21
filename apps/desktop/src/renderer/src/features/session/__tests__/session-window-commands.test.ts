import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    bootstrap: { selectedSessionId: 'a', sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    didSelectSession: vi.fn<(sessionId: string) => Promise<boolean>>(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn() } }));
vi.mock('../../../stores/selectors', () => ({ getBootstrap: () => mocks.bootstrap }));
vi.mock('../../primary-sidebar/pinned-session-order', () => ({
    pinnedSessions: (sessions: unknown[]) => sessions,
}));
vi.mock('../session-commands', () => ({ didSelectSession: mocks.didSelectSession }));

import {
    canOpenSessionInNewWindow,
    openPinnedSessionAtPosition,
    pinnedSessionTargetId,
} from '../session-window-commands';

describe('canOpenSessionInNewWindow', () => {
    it('offers any Session this window does not show and no other window has open', () => {
        expect(
            canOpenSessionInNewWindow(
                { selectedSessionId: 'shown', otherWindowOpenSessionIds: ['elsewhere'] },
                'idle',
            ),
        ).toBe(true);
    });

    it('never offers the shown Session, which would leave this window empty', () => {
        expect(canOpenSessionInNewWindow({ selectedSessionId: 'shown' }, 'shown')).toBe(false);
    });

    it('never offers a Session another window has open, which selecting brings forward', () => {
        expect(
            canOpenSessionInNewWindow(
                { selectedSessionId: 'shown', otherWindowOpenSessionIds: ['elsewhere'] },
                'elsewhere',
            ),
        ).toBe(false);
    });
});

describe('pinnedSessionTargetId', () => {
    const pinned = ['a', 'b', 'c'];

    it('maps positions 1 to 8 to the Pinned group in order', () => {
        expect(pinnedSessionTargetId(pinned, 1)).toBe('a');
        expect(pinnedSessionTargetId(pinned, 3)).toBe('c');
    });

    it('maps 9 to the last Pinned Session however many there are', () => {
        expect(pinnedSessionTargetId(pinned, 9)).toBe('c');
        expect(
            pinnedSessionTargetId(
                Array.from({ length: 12 }, (_, index) => `s${index}`),
                9,
            ),
        ).toBe('s11');
    });

    it('selects nothing past the end or outside 1 to 9', () => {
        expect(pinnedSessionTargetId(pinned, 4)).toBeUndefined();
        expect(pinnedSessionTargetId(pinned, 0)).toBeUndefined();
        expect(pinnedSessionTargetId([], 9)).toBeUndefined();
    });
});

describe('openPinnedSessionAtPosition', () => {
    it('honors a second press while the first selection is still in flight', async () => {
        const first = Promise.withResolvers<boolean>();
        mocks.didSelectSession.mockReturnValueOnce(first.promise).mockResolvedValue(true);

        // The snapshot still shows `a` while `Cmd+2` is pending, so the old check took `Cmd+1` back to `a` for a no-op.
        openPinnedSessionAtPosition(2);
        openPinnedSessionAtPosition(1);
        openPinnedSessionAtPosition(1);
        first.resolve(true);
        await Promise.resolve();

        expect(mocks.didSelectSession.mock.calls).toEqual([['b'], ['a']]);
    });

    it('skips the Session the window already shows', () => {
        mocks.didSelectSession.mockClear();
        openPinnedSessionAtPosition(1);
        expect(mocks.didSelectSession).not.toHaveBeenCalled();
    });
});

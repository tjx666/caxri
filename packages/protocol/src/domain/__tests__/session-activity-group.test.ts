import { describe, expect, it } from 'vitest';

import {
    compareSessionActivityGroupRows,
    isWithinSessionFinishedRetention,
    SESSION_FINISHED_RETENTION_MS,
    sessionActivityGroup,
} from '../session-activity-group';

const NOW = 1_000_000_000;

const session = (overrides: Partial<Parameters<typeof sessionActivityGroup>[0]> = {}) => ({
    hasUnread: false,
    isDetached: false,
    isRunning: false,
    lastActivityState: 'idle' as const,
    lastSessionActivityAt: NOW,
    ...overrides,
});

describe('isWithinSessionFinishedRetention', () => {
    it('keeps a Session until the window closes, and one whose clock is ahead of the reader', () => {
        expect(isWithinSessionFinishedRetention({ lastSessionActivityAt: NOW }, NOW)).toBe(true);
        const edge = NOW - SESSION_FINISHED_RETENTION_MS;
        expect(isWithinSessionFinishedRetention({ lastSessionActivityAt: edge + 1 }, NOW)).toBe(
            true,
        );
        expect(isWithinSessionFinishedRetention({ lastSessionActivityAt: edge }, NOW)).toBe(false);
        expect(isWithinSessionFinishedRetention({ lastSessionActivityAt: NOW + 5_000 }, NOW)).toBe(
            true,
        );
    });
});

describe('sessionActivityGroup', () => {
    it('ranks unread above every state, including a running turn', () => {
        expect(sessionActivityGroup(session({ hasUnread: true, isRunning: true }), NOW)).toBe(
            'attention',
        );
    });

    it('keeps a failure even when detached, and files a detached Session as idle', () => {
        expect(
            sessionActivityGroup(session({ isDetached: true, lastActivityState: 'failed' }), NOW),
        ).toBe('failed');
        expect(
            sessionActivityGroup(session({ isDetached: true, lastActivityState: 'waiting' }), NOW),
        ).toBe('idle');
    });

    it('maps running, waiting, and idle states, and ages a finished Session out', () => {
        expect(sessionActivityGroup(session({ isRunning: true }), NOW)).toBe('working');
        expect(sessionActivityGroup(session({ lastActivityState: 'waiting' }), NOW)).toBe(
            'waiting',
        );
        expect(sessionActivityGroup(session({ lastActivityState: 'unknown' }), NOW)).toBe('idle');
        expect(sessionActivityGroup(session({ lastActivityState: 'completed' }), NOW)).toBe(
            'finished',
        );
        expect(
            sessionActivityGroup(
                session({
                    lastActivityState: 'completed',
                    lastSessionActivityAt: NOW - SESSION_FINISHED_RETENTION_MS,
                }),
                NOW,
            ),
        ).toBeUndefined();
    });
});

describe('compareSessionActivityGroupRows', () => {
    it('puts the most recent work first and breaks ties by id', () => {
        const rows = [
            { id: 'b', lastSessionActivityAt: 1 },
            { id: 'c', lastSessionActivityAt: 2 },
            { id: 'a', lastSessionActivityAt: 1 },
        ];
        expect(rows.toSorted(compareSessionActivityGroupRows).map((row) => row.id)).toEqual([
            'c',
            'a',
            'b',
        ]);
    });
});

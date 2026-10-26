import { describe, expect, it } from 'vitest';

import type { SessionRecord } from '../domain.js';
import { compareSessionActivityRecency } from '../session-order.js';

function session(
    id: string,
    lastSessionActivityAt: number,
    overrides: Partial<SessionRecord> = {},
) {
    return {
        id,
        createdAt: lastSessionActivityAt,
        lastOpenedAt: lastSessionActivityAt,
        lastSessionActivityAt,
        ...overrides,
    } as SessionRecord;
}

describe('compareSessionActivityRecency', () => {
    it('orders newest activity first without using last-opened time', () => {
        expect(
            [
                session('older', 10, { lastOpenedAt: 1_000 }),
                session('newer', 20, { lastOpenedAt: 1 }),
            ]
                .toSorted(compareSessionActivityRecency)
                .map(({ id }) => id),
        ).toEqual(['newer', 'older']);
    });

    it('breaks equal activity times by creation time and then id', () => {
        expect(
            [
                session('session-c', 20, { createdAt: 10 }),
                session('session-b', 20, { createdAt: 20 }),
                session('session-a', 20, { createdAt: 20 }),
            ]
                .toSorted(compareSessionActivityRecency)
                .map(({ id }) => id),
        ).toEqual(['session-a', 'session-b', 'session-c']);
    });
});

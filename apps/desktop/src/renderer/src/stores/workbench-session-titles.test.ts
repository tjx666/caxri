import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    beginPendingSessionTitle,
    settlePendingSessionTitle,
    withPendingSessionTitles,
} from './workbench-session-titles';

function session(id: string, displayTitle: string): SessionRecord {
    return { id, displayTitle } as SessionRecord;
}

describe('pending Session titles', () => {
    it('keeps an unconfirmed rename across snapshots and restores the old name when it fails', () => {
        const attempt = beginPendingSessionTitle('session-1', 'New', 'Old');

        const snapshot = [session('session-1', 'Old'), session('session-2', 'Other')];
        expect(withPendingSessionTitles(snapshot).map(({ displayTitle }) => displayTitle)).toEqual([
            'New',
            'Other',
        ]);

        expect(settlePendingSessionTitle('session-1', attempt, false)).toBe('Old');
        expect(withPendingSessionTitles(snapshot)).toBe(snapshot);
    });

    it('lets only the newest rename decide, and falls back to the name the Server last reported', () => {
        const first = beginPendingSessionTitle('session-1', 'First', 'Old');
        const second = beginPendingSessionTitle('session-1', 'Second', 'First');

        // The first rename committed on the Server while the second is still in flight.
        expect(withPendingSessionTitles([session('session-1', 'First')])[0]?.displayTitle).toBe(
            'Second',
        );
        expect(settlePendingSessionTitle('session-1', first, true)).toBeUndefined();
        expect(settlePendingSessionTitle('session-1', second, false)).toBe('First');
    });

    it('drops the overlay once the newest rename commits', () => {
        const attempt = beginPendingSessionTitle('session-1', 'New', 'Old');

        expect(settlePendingSessionTitle('session-1', attempt, true)).toBeUndefined();
        const snapshot = [session('session-1', 'New')];
        expect(withPendingSessionTitles(snapshot)).toBe(snapshot);
    });
});

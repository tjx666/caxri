import { describe, expect, it } from 'vitest';

import {
    mergeSavedRecentSessions,
    previousRecentSession,
    RECENT_SESSIONS_MAX_ENTRIES,
    recentSessionsSchema,
    rememberRecentSession,
} from '../recent-sessions';

const listed = (...ids: string[]) => ids.map((id) => ({ id }));

describe('rememberRecentSession', () => {
    it('moves a reopened Session to the front without duplicating it', () => {
        expect(rememberRecentSession(['b', 'a', 'c'], 'a')).toEqual(['a', 'b', 'c']);
        expect(rememberRecentSession(['a'], 'b')).toEqual(['b', 'a']);
    });

    it('keeps the same list when the newest Session opens again', () => {
        const recent = ['a', 'b'];
        expect(rememberRecentSession(recent, 'a')).toBe(recent);
    });

    it('drops the oldest Session past the limit', () => {
        const full = Array.from({ length: RECENT_SESSIONS_MAX_ENTRIES }, (_, index) => `s${index}`);
        const next = rememberRecentSession(full, 'new');
        expect(next).toHaveLength(RECENT_SESSIONS_MAX_ENTRIES);
        expect(next[0]).toBe('new');
        expect(next).not.toContain(full.at(-1));
        expect(recentSessionsSchema.safeParse(next).success).toBe(true);
    });
});

describe('mergeSavedRecentSessions', () => {
    it('keeps Sessions opened in this launch ahead of the saved list', () => {
        expect(mergeSavedRecentSessions(['c'], ['a', 'c', 'b'])).toEqual(['c', 'a', 'b']);
    });
});

describe('previousRecentSession', () => {
    it('toggles between the two most recently opened Sessions', () => {
        const sessions = listed('a', 'b');
        let recent = rememberRecentSession(rememberRecentSession([], 'a'), 'b');
        expect(previousRecentSession(recent, 'b', sessions)?.id).toBe('a');
        recent = rememberRecentSession(recent, 'a');
        expect(previousRecentSession(recent, 'a', sessions)?.id).toBe('b');
    });

    it('skips a Session the list no longer has', () => {
        expect(previousRecentSession(['c', 'gone', 'a'], 'c', listed('a', 'c'))?.id).toBe('a');
    });

    it('offers nothing when no other listed Session was opened', () => {
        expect(previousRecentSession(['a'], 'a', listed('a', 'b'))).toBeNull();
        expect(previousRecentSession([], 'a', listed('a'))).toBeNull();
    });
});

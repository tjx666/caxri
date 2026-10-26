import { describe, expect, it } from 'vitest';

import { sessionCardStatusLine } from '../session-card-status';

const settled = {
    hasUnread: false,
    lastActivityState: 'idle',
    lastAttentionKind: undefined,
} as const;

describe('Session hover card status line', () => {
    it('adds no line for a settled Session', () => {
        expect(sessionCardStatusLine(settled)).toBeUndefined();
    });

    it('names a running Session', () => {
        expect(sessionCardStatusLine({ ...settled, lastActivityState: 'running' })).toBe('Working');
    });

    it('names unread attention with its kind', () => {
        expect(
            sessionCardStatusLine({
                ...settled,
                hasUnread: true,
                lastActivityState: 'waiting',
                lastAttentionKind: 'waiting',
            }),
        ).toBe('Unread, waiting for you');
    });

    it('names a detached Agent', () => {
        expect(sessionCardStatusLine(settled, { lastProcessState: 'detached' })).toBe('Detached');
    });
});

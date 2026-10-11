import { beforeEach, describe, expect, it } from 'vitest';

import {
    requestPinnedSessionReveal,
    settlePinnedSessionReveal,
    usePinnedSessionRevealStore,
} from '../pinned-session-reveal';

beforeEach(() => {
    settlePinnedSessionReveal('');
});

describe('pinned Session reveal requests', () => {
    it('bumps the revision so pinning the same Session again is a new request', () => {
        requestPinnedSessionReveal('session-1');
        const first = usePinnedSessionRevealStore.getState().request;
        requestPinnedSessionReveal('session-1');
        const second = usePinnedSessionRevealStore.getState().request;

        expect(first?.sessionId).toBe('session-1');
        expect(second?.sessionId).toBe('session-1');
        expect(second?.id).toBe((first?.id ?? 0) + 1);
    });

    it('is consumed with its announcement once the sidebar has revealed the row', () => {
        requestPinnedSessionReveal('session-2');
        settlePinnedSessionReveal('Pinned Fix login');

        expect(usePinnedSessionRevealStore.getState()).toMatchObject({
            announcement: 'Pinned Fix login',
            request: undefined,
        });
    });
});

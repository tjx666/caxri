import { describe, expect, it } from 'vitest';

import { sessionShowRefresh } from '../session-show-refresh';

describe('Session detail refresh', () => {
    const base = {
        isObservable: true,
        subscriptionAvailable: true,
        subscriptionIdentity: 'device:session',
        subscriptionState: { identity: 'device:session', mode: 'active' as const },
    };

    it('reads on subscription acknowledgement without a periodic request', () => {
        expect(sessionShowRefresh(base)).toEqual({ enabled: true, pollInterval: false });
    });

    it('polls only when the push subscription is unavailable', () => {
        expect(sessionShowRefresh({ ...base, subscriptionAvailable: false })).toEqual({
            enabled: true,
            pollInterval: 2_500,
        });
        expect(
            sessionShowRefresh({
                ...base,
                subscriptionState: { ...base.subscriptionState, mode: 'fallback' },
            }),
        ).toEqual({
            enabled: true,
            pollInterval: 2_500,
        });
    });

    it('holds the read until a replacement subscription is acknowledged', () => {
        expect(sessionShowRefresh({ ...base, subscriptionIdentity: 'other:session' })).toEqual({
            enabled: false,
            pollInterval: false,
        });
        expect(sessionShowRefresh({ ...base, isObservable: false })).toEqual({
            enabled: false,
            pollInterval: false,
        });
    });
});

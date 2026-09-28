import { describe, expect, it } from 'vitest';

import {
    CONNECTION_STALE_AFTER_MS,
    connectionFreshness,
    initialConnectionClock,
    isConnectionFresh,
    MAXIMUM_RECONNECT_DELAY_MS,
    reconnectDelay,
} from '../connection-state';

describe('connection state', () => {
    it('becomes stale at the five-second boundary', () => {
        expect(connectionFreshness(1_000, 1_000 + CONNECTION_STALE_AFTER_MS - 1)).toBe('fresh');
        expect(connectionFreshness(1_000, 1_000 + CONNECTION_STALE_AFTER_MS)).toBe('stale');
    });

    it('seeds the first-render clock from the client instead of a stale null placeholder (#1329)', () => {
        const recentLastSeenAt = Date.now();
        const clock = initialConnectionClock(() => recentLastSeenAt);
        expect(clock.lastSeenAt).toBe(recentLastSeenAt);
        /**
         * A `null`/`0` placeholder would make `isConnectionFresh` read as stale on the first paint even though the
         * client already has a recent observation, flashing the Connection banner for one frame before the effect
         * corrects it -- this is the regression `initialConnectionClock` replaces.
         */
        expect(isConnectionFresh('connected', clock.lastSeenAt, clock.now)).toBe(true);
    });

    it('still reads as stale when the client has never observed the socket', () => {
        const clock = initialConnectionClock(() => null);
        expect(isConnectionFresh('connected', clock.lastSeenAt, clock.now)).toBe(false);
    });

    it('does not treat an old observation as fresh just because the socket still reports connected', () => {
        expect(isConnectionFresh('connected', 1_000, 1_000 + CONNECTION_STALE_AFTER_MS)).toBe(
            false,
        );
        expect(isConnectionFresh('connected', 1_000, 1_100)).toBe(true);
        expect(isConnectionFresh('stale', 1_000, 1_100)).toBe(false);
    });

    it('bounds exponential reconnect delay', () => {
        expect(reconnectDelay(-1)).toBe(500);
        expect(reconnectDelay(0)).toBe(500);
        expect(reconnectDelay(3)).toBe(4_000);
        expect(reconnectDelay(100)).toBe(MAXIMUM_RECONNECT_DELAY_MS);
    });
});

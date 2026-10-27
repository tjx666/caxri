import { describe, expect, it } from 'vitest';

import {
    CONNECTION_CLOCK_STEP_MS,
    CONNECTION_STALE_AFTER_MS,
    connectionFreshness,
    initialConnectionClock,
    isConnectionFresh,
    MAXIMUM_RECONNECT_DELAY_MS,
    nextConnectionClock,
    reconnectDelay,
} from '../connection-state';

describe('connection state', () => {
    it('becomes stale at the five-second boundary', () => {
        expect(connectionFreshness(1_000, 1_000 + CONNECTION_STALE_AFTER_MS - 1)).toBe('fresh');
        expect(connectionFreshness(1_000, 1_000 + CONNECTION_STALE_AFTER_MS)).toBe('stale');
    });

    it('seeds the first-render clock from the client instead of a stale null placeholder (#1329)', () => {
        const recentLastSeenAt = Date.now();
        /**
         * A `null`/`0` placeholder would make `isConnectionFresh` read as stale on the first paint even though the
         * client already has a recent observation, flashing the Connection banner for one frame before the effect
         * corrects it -- this is the regression `initialConnectionClock` replaces.
         */
        expect(initialConnectionClock('connected', () => recentLastSeenAt).fresh).toBe(true);
    });

    it('still reads as stale when the client has never observed the socket', () => {
        expect(initialConnectionClock('connected', () => null).fresh).toBe(false);
    });

    it('does not treat an old observation as fresh just because the socket still reports connected', () => {
        expect(isConnectionFresh('connected', 1_000, 1_000 + CONNECTION_STALE_AFTER_MS)).toBe(
            false,
        );
        expect(isConnectionFresh('connected', 1_000, 1_100)).toBe(true);
        expect(isConnectionFresh('stale', 1_000, 1_100)).toBe(false);
    });

    it('keeps the same clock while a sample changes nothing on screen', () => {
        const start = 10 * CONNECTION_CLOCK_STEP_MS;
        const clock = nextConnectionClock(null, 'connected', start, start);
        expect(clock).toEqual({ fresh: true, now: start });
        // A second later the connection is still fresh and the ages still read the same.
        expect(nextConnectionClock(clock, 'connected', start + 1_000, start + 1_000)).toBe(clock);
    });

    it('publishes a freshness change at once', () => {
        const start = 10 * CONNECTION_CLOCK_STEP_MS;
        const clock = nextConnectionClock(null, 'connected', start, start);
        const stale = nextConnectionClock(
            clock,
            'connected',
            start,
            start + CONNECTION_STALE_AFTER_MS,
        );
        expect(stale).toEqual({ fresh: false, now: start });
        expect(nextConnectionClock(clock, 'stale', start, start + 1_000)).toEqual({
            fresh: false,
            now: start,
        });
        expect(nextConnectionClock(clock, 'connected', null, start)).toEqual({
            fresh: false,
            now: start,
        });
    });

    it('moves the time ages are measured against one step at a time', () => {
        const start = 10 * CONNECTION_CLOCK_STEP_MS;
        const clock = nextConnectionClock(null, 'connected', start, start + 1_000);
        expect(clock.now).toBe(start);
        const later = start + CONNECTION_CLOCK_STEP_MS + 2_000;
        expect(nextConnectionClock(clock, 'connected', later, later)).toEqual({
            fresh: true,
            now: start + CONNECTION_CLOCK_STEP_MS,
        });
    });

    it('bounds exponential reconnect delay', () => {
        expect(reconnectDelay(-1)).toBe(500);
        expect(reconnectDelay(0)).toBe(500);
        expect(reconnectDelay(3)).toBe(4_000);
        expect(reconnectDelay(100)).toBe(MAXIMUM_RECONNECT_DELAY_MS);
    });
});

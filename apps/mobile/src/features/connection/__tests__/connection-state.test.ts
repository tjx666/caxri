import { describe, expect, it } from 'vitest';

import {
    CONNECTION_STALE_AFTER_MS,
    connectionFreshness,
    isConnectionFresh,
    MAXIMUM_RECONNECT_DELAY_MS,
    reconnectDelay,
} from '../connection-state';

describe('connection state', () => {
    it('becomes stale at the five-second boundary', () => {
        expect(connectionFreshness(1_000, 1_000 + CONNECTION_STALE_AFTER_MS - 1)).toBe('fresh');
        expect(connectionFreshness(1_000, 1_000 + CONNECTION_STALE_AFTER_MS)).toBe('stale');
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

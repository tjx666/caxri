export const CONNECTION_STALE_AFTER_MS = 5_000;
export const MAXIMUM_RECONNECT_DELAY_MS = 30_000;

export type ConnectionFreshness = 'fresh' | 'stale';
export type MobileConnectionStatus =
    | 'booting'
    | 'connected'
    | 'connecting'
    | 'revoked'
    | 'stale'
    | 'storage-error'
    | 'unpaired'
    | 'unverified'
    | 'version-mismatch';

export const connectionFreshness = (lastSeenAt: number, now: number): ConnectionFreshness =>
    now - lastSeenAt >= CONNECTION_STALE_AFTER_MS ? 'stale' : 'fresh';

export const isConnectionFresh = (
    status: MobileConnectionStatus,
    lastSeenAt: number | null,
    now: number,
): boolean =>
    status === 'connected' &&
    lastSeenAt !== null &&
    connectionFreshness(lastSeenAt, now) === 'fresh';

export interface ConnectionClock {
    lastSeenAt: number | null;
    now: number;
}

/**
 * A `useState(() => initialConnectionClock(...))` lazy initializer reads the client's already-known `lastSeenAt` on the
 * very first render, instead of a `null`/`0` placeholder. `isConnectionFresh` always reads a `null` `lastSeenAt` as
 * stale, so seeding state with that placeholder makes the Sessions screen's first paint show the Connection banner even
 * when the socket is already fresh; the banner then disappears once the first effect tick corrects it a moment later, a
 * one-frame layout flash on every Home/Session mount (#1329).
 */
export const initialConnectionClock = (getLastSeenAt: () => number | null): ConnectionClock => ({
    lastSeenAt: getLastSeenAt(),
    now: Date.now(),
});

export const reconnectDelay = (attempt: number): number => {
    const boundedAttempt = Math.max(0, Math.min(attempt, 10));
    return Math.min(500 * 2 ** boundedAttempt, MAXIMUM_RECONNECT_DELAY_MS);
};

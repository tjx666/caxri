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

/**
 * How far the published clock's `now` moves at a time. The Sessions screen samples the connection every second so the
 * Connection banner reacts within a second, but its ages (`now`, `5m`) only change by the minute; publishing every
 * sample re-rendered the whole screen each second for nothing.
 */
export const CONNECTION_CLOCK_STEP_MS = 15_000;

/**
 * What the Sessions screen renders from its once-a-second connection sample: whether the connection is fresh, and the
 * time its ages are measured against, rounded down to {@link CONNECTION_CLOCK_STEP_MS}.
 */
export interface ConnectionClock {
    fresh: boolean;
    now: number;
}

/**
 * The clock to publish after a sample. It returns `previous` itself while neither freshness nor the stepped time
 * changed, so a `setState` with it bails out without re-rendering; a freshness change publishes at once.
 */
export const nextConnectionClock = (
    previous: ConnectionClock | null,
    status: MobileConnectionStatus,
    lastSeenAt: number | null,
    now: number,
): ConnectionClock => {
    const isFresh = isConnectionFresh(status, lastSeenAt, now);
    const stepped = now - (now % CONNECTION_CLOCK_STEP_MS);
    return previous?.fresh === isFresh && previous.now === stepped
        ? previous
        : { fresh: isFresh, now: stepped };
};

/**
 * A `useState(() => initialConnectionClock(...))` lazy initializer reads the client's already-known `lastSeenAt` on the
 * very first render, instead of a `null`/`0` placeholder. `isConnectionFresh` always reads a `null` `lastSeenAt` as
 * stale, so seeding state with that placeholder makes the Sessions screen's first paint show the Connection banner even
 * when the socket is already fresh; the banner then disappears once the first effect tick corrects it a moment later, a
 * one-frame layout flash on every Home/Session mount (#1329).
 */
export const initialConnectionClock = (
    status: MobileConnectionStatus,
    getLastSeenAt: () => number | null,
): ConnectionClock => nextConnectionClock(null, status, getLastSeenAt(), Date.now());

export const reconnectDelay = (attempt: number): number => {
    const boundedAttempt = Math.max(0, Math.min(attempt, 10));
    return Math.min(500 * 2 ** boundedAttempt, MAXIMUM_RECONNECT_DELAY_MS);
};

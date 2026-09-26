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

export const reconnectDelay = (attempt: number): number => {
    const boundedAttempt = Math.max(0, Math.min(attempt, 10));
    return Math.min(500 * 2 ** boundedAttempt, MAXIMUM_RECONNECT_DELAY_MS);
};

import { MobileGatewayRequestError } from './mobile-gateway-errors';

/**
 * Codes with which the Server refuses a write before acting on it. Only these prove nothing happened; any other failure
 * (a timeout, a dropped socket, `UNAVAILABLE`, `INTERNAL`) can arrive after the Server already acted, so the phone must
 * not claim the write was lost.
 */
const REJECTION_CODES: ReadonlySet<string> = new Set([
    'CAPACITY',
    'CONFLICT',
    'FORBIDDEN',
    'NOT_FOUND',
    'VALIDATION',
]);

/**
 * The message `useMobileClientController().request` throws when no connection exists, before anything is sent.
 */
const NOT_CONNECTED_MESSAGE = 'Caxri is reconnecting.';

/**
 * What a failed write tells the phone about its effect:
 *
 * - `rejected`: the Server refused it with an explicit code; nothing happened, and retrying is safe.
 * - `offline`: the phone had no connection, so the request never left it.
 * - `unknown`: the Server may or may not have acted; the user must check before repeating it.
 */
export type MobileWriteFailure =
    { kind: 'rejected'; code: string } | { kind: 'offline' } | { kind: 'unknown' };

/**
 * Classifies a failed mobile write (sending a Chat message, creating a Session) by whether it provably did not happen.
 * Shared by every caller that words a failure, so "not sent" is never shown for a write that may have gone through.
 */
export const classifyMobileWriteFailure = (error: unknown): MobileWriteFailure => {
    if (error instanceof MobileGatewayRequestError && REJECTION_CODES.has(error.code))
        return { kind: 'rejected', code: error.code };
    if (error instanceof Error && error.message === NOT_CONNECTED_MESSAGE)
        return { kind: 'offline' };
    return { kind: 'unknown' };
};

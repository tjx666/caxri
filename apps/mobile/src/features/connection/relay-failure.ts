import type { MobileRelayFailureReason } from './gateway-routes';
import { MobileRelayUnavailableError } from './gateway-routes';

/**
 * The Relay failures a phone user can act on, grouped from the Relay's close reasons: the computer is not reachable
 * through the Relay, the Relay does not accept this phone, or the Relay is overloaded. Every other reason (a dropped
 * socket, a malformed frame) stays a plain "could not connect".
 */
export type MobileRelayFailureKind = 'busy' | 'host-offline' | 'unauthorized';

const kindByReason: Readonly<Partial<Record<MobileRelayFailureReason, MobileRelayFailureKind>>> = {
    'capacity': 'busy',
    'host-offline': 'host-offline',
    'host-timeout': 'host-offline',
    'rate-limited': 'busy',
    'shutting-down': 'busy',
    'unauthorized': 'unauthorized',
};

/**
 * The actionable kind behind a failed connection attempt, or `null` when the error is not a specific Relay refusal.
 */
export const relayFailureKindOf = (error: unknown): MobileRelayFailureKind | null =>
    error instanceof MobileRelayUnavailableError ? (kindByReason[error.reason] ?? null) : null;

import { describe, expect, it } from 'vitest';

import { MobileRelayUnavailableError } from '../gateway-routes';
import { relayFailureKindOf } from '../relay-failure';

describe('relayFailureKindOf', () => {
    it.each([
        ['host-offline', 'host-offline'],
        ['host-timeout', 'host-offline'],
        ['unauthorized', 'unauthorized'],
        ['capacity', 'busy'],
        ['rate-limited', 'busy'],
        ['shutting-down', 'busy'],
    ] as const)('groups Relay reason %s as %s', (reason, kind) => {
        expect(relayFailureKindOf(new MobileRelayUnavailableError(reason))).toBe(kind);
    });

    it('returns null for unspecific Relay failures and unrelated errors', () => {
        expect(relayFailureKindOf(new MobileRelayUnavailableError('unreachable'))).toBeNull();
        expect(relayFailureKindOf(new MobileRelayUnavailableError('peer-gone'))).toBeNull();
        expect(relayFailureKindOf(new Error('x'))).toBeNull();
    });
});

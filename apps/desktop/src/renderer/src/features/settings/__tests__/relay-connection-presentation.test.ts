import { describe, expect, it } from 'vitest';

import { presentRelayConnection } from '../relay-connection-presentation';

const hostId = 'a'.repeat(32);

describe('presentRelayConnection', () => {
    it('shows nothing without a configured Relay', () => {
        expect(presentRelayConnection(undefined)).toBeUndefined();
    });

    it('shows connected when registered', () => {
        expect(presentRelayConnection({ hostId, state: 'online' })).toMatchObject({
            kind: 'connected',
        });
    });

    it('shows connecting before any failure is recorded', () => {
        expect(presentRelayConnection({ hostId, state: 'connecting' })).toMatchObject({
            kind: 'connecting',
        });
    });

    it('keeps showing the failure and its reason while the next attempt is connecting', () => {
        for (const state of ['offline', 'connecting'] as const)
            expect(presentRelayConnection({ hostId, lastFailure: 'network-error', state })).toEqual(
                {
                    kind: 'failed',
                    labelKey: 'settings.mobile.relayStatus.failed',
                    reasonKey: 'settings.mobile.relayStatus.reason.networkError',
                },
            );
    });
});

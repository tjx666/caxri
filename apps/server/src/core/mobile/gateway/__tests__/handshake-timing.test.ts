import { describe, expect, it } from 'vitest';

import { handshakeTimingFields } from '../handshake-timing';

describe('handshake timing fields', () => {
    it('splits a Relay reconnect into its legs, including what the phone reported', () => {
        expect(
            handshakeTimingFields(
                {
                    acceptedAt: 1_000,
                    dialMs: 140,
                    helloAt: 1_080,
                    challengeAt: 1_085,
                    confirmAt: 1_240,
                    trace: { graceMs: 300, openMs: 910 },
                },
                1_250,
            ),
        ).toEqual({
            handshakeMs: 250,
            helloWaitMs: 80,
            confirmWaitMs: 155,
            authMs: 10,
            dialMs: 140,
            clientGraceMs: 300,
            clientOpenMs: 910,
        });
    });

    it('omits legs a pairing or LAN handshake never had', () => {
        expect(handshakeTimingFields({ acceptedAt: 0, helloAt: 5 }, 20)).toEqual({
            handshakeMs: 20,
            helloWaitMs: 5,
        });
    });
});

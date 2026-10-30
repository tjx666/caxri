import type { MobileConnectTrace } from '@caxri/mobile-transport';

/**
 * Clock marks of one phone socket's handshake. Together with the phone's own trace they split a reconnect into the
 * route race on the phone, the Relay dial-back, and each handshake round trip.
 */
export interface MobileHandshakeTiming {
    acceptedAt: number;
    challengeAt?: number;
    confirmAt?: number;
    /**
     * For a Relay socket: from the Relay's `relay-incoming` until the Server's dial-back socket opened.
     */
    dialMs?: number;
    helloAt?: number;
    /**
     * What the phone reported in its reconnect hello; pairing hellos carry none.
     */
    trace?: MobileConnectTrace;
}

type TimingFields = Record<string, number>;

/**
 * Flat, content-free fields for `connection_established`. `helloWaitMs` covers the phone's first frame crossing the
 * route; `confirmWaitMs` is one full phone round trip; `authMs` is the Server's own credential check.
 */
export const handshakeTimingFields = (
    timing: MobileHandshakeTiming,
    readyAt: number,
): TimingFields => {
    const fields: TimingFields = { handshakeMs: readyAt - timing.acceptedAt };
    if (timing.helloAt !== undefined) fields.helloWaitMs = timing.helloAt - timing.acceptedAt;
    if (timing.challengeAt !== undefined && timing.confirmAt !== undefined)
        fields.confirmWaitMs = timing.confirmAt - timing.challengeAt;
    if (timing.confirmAt !== undefined) fields.authMs = readyAt - timing.confirmAt;
    if (timing.dialMs !== undefined) fields.dialMs = timing.dialMs;
    if (timing.trace) {
        fields.clientGraceMs = timing.trace.graceMs;
        fields.clientOpenMs = timing.trace.openMs;
    }
    return fields;
};

import type {
    HandshakeTranscript,
    MobileFrameCounter,
    MobileReplayGuard,
    MobileSessionKeys,
} from '@caxri/mobile-transport';
import type { Principal, ProtocolConnectionIdentity } from '@caxri/protocol';

import type { MobileDeviceRecord } from '../device-registry';
import type { MobileConnectionRoute } from './diagnostics';
import type { MobileGatewayFrameRouter } from './frame-router';
import type { MobileHandshakeTiming } from './handshake-timing';

/**
 * One accepted mobile socket, from its handshake through its active application session.
 */
export interface GatewaySession {
    application?: MobileGatewayFrameRouter;
    candidate?: MobileDeviceRecord;
    connection: ProtocolConnectionIdentity;
    deviceId: string;
    generation: number;
    inbound: MobileReplayGuard;
    keys: MobileSessionKeys;
    /**
     * The gateway address this phone reached; update download URLs reuse it.
     */
    localAddress?: string;
    mode: 'connect' | 'pair';
    /**
     * How the phone reached the gateway: its LAN listener, or a Relay dial-back with no local address.
     */
    route: MobileConnectionRoute;
    outbound: MobileFrameCounter;
    principal?: Principal;
    /**
     * Set once the handshake completes; `remove()` uses it to log the connection's `durationMs`.
     */
    readyAt?: number;
    revoking?: boolean;
    timing: MobileHandshakeTiming;
    transcript: HandshakeTranscript;
    valid: boolean;
}

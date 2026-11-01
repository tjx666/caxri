import { MOBILE_GATEWAY_MAX_WIRE_BYTES, mobileRevokedSchema } from '@caxri/mobile-transport';
import type WebSocket from 'ws';

import type { GatewaySession } from './gateway-session';
import { sealSessionPayload, sendFinalSealedPayload } from './sealed-payload';

/**
 * A revocation is disclosed only over the already authenticated session. The bounded close handshake preserves wire
 * ordering for the encrypted control frame without letting a backpressured client delay Desktop indefinitely.
 */
export const sendRevokedAndClose = async (
    socket: WebSocket,
    session: GatewaySession,
): Promise<void> => {
    const revoked = mobileRevokedSchema.parse({
        type: 'revoked',
        deviceId: session.deviceId,
        generation: session.generation,
    });
    const sourceFrame = sealSessionPayload(session, revoked);
    const maxBytes = MOBILE_GATEWAY_MAX_WIRE_BYTES * 2;
    const closeResult = await sendFinalSealedPayload(socket, sourceFrame, maxBytes);
    if (closeResult === 'failed') {
        session.application?.close();
        socket.terminate();
    }
};

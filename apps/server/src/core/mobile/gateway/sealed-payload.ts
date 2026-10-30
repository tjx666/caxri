import { Buffer } from 'node:buffer';

import {
    decodeHex,
    encodeHex,
    MOBILE_TRANSPORT_VERSION,
    mobileSealedFrameSchema,
    openMobileFrame,
    sealMobileFrame,
} from '@caxri/mobile-transport';
import WebSocket from 'ws';

import type { GatewaySession } from './gateway-session';

const FINAL_FRAME_CLOSE_TIMEOUT_MS = 1_000;

/**
 * Marker for `MobileReplayGuard`'s counter-sequence rejection so it logs as `replayRejected`, not `invalidFrame`.
 */
export class MobileFrameReplayRejected extends Error {}

/**
 * Opens one sealed frame from the phone and returns its parsed application payload.
 */
export const openSessionPayload = (session: GatewaySession, raw: unknown): unknown => {
    const frame = mobileSealedFrameSchema.parse(raw);
    if (frame.connectionId !== session.connection.connectionId)
        throw new Error('Encrypted frame connection identity changed');
    // Narrowed to a distinct error type so the outer catch can log `replayRejected` instead of folding a replayed
    // or out-of-order counter into the generic `invalidFrame` bucket it shares with malformed payloads.
    try {
        session.inbound.assertAndAdvance(frame.counter);
    } catch (error) {
        throw new MobileFrameReplayRejected(error instanceof Error ? error.message : undefined);
    }
    const plaintext = openMobileFrame(
        session.keys.clientToServer,
        {
            connectionId: session.transcript.connectionId,
            counter: frame.counter,
            deviceId: session.deviceId,
            direction: 'client-to-server',
        },
        decodeHex(frame.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
};

interface ServerSealedPayloadContext {
    connectionId: Uint8Array;
    connectionIdHex: string;
    counter: number;
    deviceId: string;
    key: Uint8Array;
}

const createServerSealedPayload = (
    context: ServerSealedPayloadContext,
    payload: unknown,
): string => {
    const ciphertext = sealMobileFrame(
        context.key,
        {
            connectionId: context.connectionId,
            counter: context.counter,
            deviceId: context.deviceId,
            direction: 'server-to-client',
        },
        new TextEncoder().encode(JSON.stringify(payload)),
    );
    return JSON.stringify(
        mobileSealedFrameSchema.parse({
            type: 'sealed',
            version: MOBILE_TRANSPORT_VERSION,
            connectionId: context.connectionIdHex,
            counter: context.counter,
            ciphertext: encodeHex(ciphertext),
        }),
    );
};

/**
 * Enqueues a final authenticated frame before starting the WebSocket close handshake. The peer cannot acknowledge the
 * later close frame without first consuming the earlier data frame from the ordered stream; a bounded timeout lets the
 * caller force-close a client that never completes the handshake.
 */
export const sendFinalSealedPayload = async (
    socket: WebSocket,
    sourceFrame: string,
    maximumBufferedBytes: number,
): Promise<'closed' | 'failed'> => {
    if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount + Buffer.byteLength(sourceFrame, 'utf8') > maximumBufferedBytes
    )
        return 'failed';
    return new Promise<'closed' | 'failed'>((resolve) => {
        let isSettled = false;
        let onClose = (): void => {};
        const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
        const settle = (result: 'closed' | 'failed'): void => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timeout.handle);
            socket.off('close', onClose);
            resolve(result);
        };
        onClose = (): void => settle('closed');
        socket.once('close', onClose);
        timeout.handle = setTimeout(() => settle('failed'), FINAL_FRAME_CLOSE_TIMEOUT_MS);
        timeout.handle.unref();
        socket.send(sourceFrame, (error) => {
            if (error) {
                settle('failed');
                return;
            }
            if (socket.readyState === WebSocket.OPEN) socket.close(1_000);
        });
    });
};

/**
 * Seals one server-to-client payload with the session's key and takes the next outbound counter.
 */
export const sealSessionPayload = (session: GatewaySession, payload: unknown): string =>
    createServerSealedPayload(
        {
            connectionId: session.transcript.connectionId,
            connectionIdHex: session.connection.connectionId,
            counter: session.outbound.take(),
            deviceId: session.deviceId,
            key: session.keys.serverToClient,
        },
        payload,
    );

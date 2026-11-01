import { decodeSealedFrame, openMobilePayload, sealMobilePayload } from '@caxri/mobile-transport';
import WebSocket from 'ws';

import type { GatewaySession } from './gateway-session';

const FINAL_FRAME_CLOSE_TIMEOUT_MS = 1_000;

/**
 * Marker for `MobileReplayGuard`'s counter-sequence rejection so it logs as `replayRejected`, not `invalidFrame`.
 */
export class MobileFrameReplayRejected extends Error {}

/**
 * Opens one binary sealed frame from the phone and returns its parsed application payload.
 */
export const openSessionPayload = (session: GatewaySession, frame: Uint8Array): unknown => {
    const { ciphertext, counter } = decodeSealedFrame(frame);
    // Narrowed to a distinct error type so the outer catch can log `replayRejected` instead of folding a replayed
    // or out-of-order counter into the generic `invalidFrame` bucket it shares with malformed payloads.
    try {
        session.inbound.assertAndAdvance(counter);
    } catch (error) {
        throw new MobileFrameReplayRejected(error instanceof Error ? error.message : undefined);
    }
    return openMobilePayload(
        session.keys.clientToServer,
        {
            connectionId: session.transcript.connectionId,
            counter,
            deviceId: session.deviceId,
            direction: 'client-to-server',
        },
        ciphertext,
    );
};

/**
 * Enqueues a final authenticated frame before starting the WebSocket close handshake. The peer cannot acknowledge the
 * later close frame without first consuming the earlier data frame from the ordered stream; a bounded timeout lets the
 * caller force-close a client that never completes the handshake.
 */
export const sendFinalSealedPayload = async (
    socket: WebSocket,
    sourceFrame: Uint8Array,
    maximumBufferedBytes: number,
): Promise<'closed' | 'failed'> => {
    if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount + sourceFrame.byteLength > maximumBufferedBytes
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
        socket.send(sourceFrame, { binary: true }, (error) => {
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
export const sealSessionPayload = (session: GatewaySession, payload: unknown): Uint8Array =>
    sealMobilePayload(
        session.keys.serverToClient,
        {
            connectionId: session.transcript.connectionId,
            counter: session.outbound.take(),
            deviceId: session.deviceId,
            direction: 'server-to-client',
        },
        payload,
    );

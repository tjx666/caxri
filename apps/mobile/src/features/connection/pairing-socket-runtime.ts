import { discardSocket } from './discard-socket';
import type { MobileGatewayRuntime } from './mobile-gateway-client';

/**
 * Cancelling discards every candidate socket, which rejects a pending handshake read at once. A socket still connecting
 * on Android cannot be closed yet, so its pending open fails when it opens or reaches its deadline, and it never
 * carries the pairing hello.
 */
export const createPairingSocketRuntime = (
    source: MobileGatewayRuntime,
    signal?: AbortSignal,
): { runtime: MobileGatewayRuntime; dispose: () => void } => {
    if (signal?.aborted) throw new Error('Pairing attempt was cancelled.');
    const sockets = new Set<WebSocket>();
    const discardSockets = (): void => {
        for (const socket of sockets) discardSocket(socket);
    };
    signal?.addEventListener('abort', discardSockets, { once: true });
    return {
        runtime: {
            openWebSocket: (url) => {
                if (signal?.aborted) throw new Error('Pairing attempt was cancelled.');
                const socket = source.openWebSocket(url);
                sockets.add(socket);
                return socket;
            },
            platform: source.platform,
            randomBytes: (length) => source.randomBytes(length),
        },
        dispose: () => signal?.removeEventListener('abort', discardSockets),
    };
};

import type { MobileGatewayRuntime } from './mobile-gateway-client';

/**
 * Closing every candidate socket also rejects a pending open or handshake read.
 */
export const createPairingSocketRuntime = (
    source: MobileGatewayRuntime,
    signal?: AbortSignal,
): { runtime: MobileGatewayRuntime; dispose: () => void } => {
    if (signal?.aborted) throw new Error('Pairing attempt was cancelled.');
    const sockets = new Set<WebSocket>();
    const closeSockets = (): void => {
        for (const socket of sockets) socket.close();
    };
    signal?.addEventListener('abort', closeSockets, { once: true });
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
        dispose: () => signal?.removeEventListener('abort', closeSockets),
    };
};

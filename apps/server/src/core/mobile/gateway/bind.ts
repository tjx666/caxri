import type { Server } from 'node:http';

import { CaxriError } from '@caxri/protocol';
import type { WebSocketServer } from 'ws';

import type { MobileDeviceRegistry } from '../device-registry';

const closeServer = (server: Server): Promise<void> =>
    new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * Listens on every interface at the port paired phones already know (an ephemeral port before the first pairing) and
 * remembers the bound port. Any failure closes both servers, so a failed enable leaves nothing listening.
 */
export const bindMobileGatewayServer = async (options: {
    registry: Pick<MobileDeviceRegistry, 'preferredPort' | 'rememberPort'>;
    server: Server;
    webSocketServer: WebSocketServer;
}): Promise<number> => {
    const { registry, server, webSocketServer } = options;
    const preferredPort = registry.preferredPort();
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => reject(error);
            server.once('error', onError);
            server.listen(preferredPort ?? 0, '0.0.0.0', () => {
                server.off('error', onError);
                resolve();
            });
        });
    } catch {
        webSocketServer.close();
        throw new CaxriError(
            'UNAVAILABLE',
            preferredPort
                ? 'The paired mobile endpoint is already in use'
                : 'Mobile access could not open a local network endpoint',
        );
    }
    const bound = server.address();
    if (!bound || typeof bound === 'string') {
        webSocketServer.close();
        await closeServer(server);
        throw new CaxriError('UNAVAILABLE', 'Mobile gateway did not publish a TCP endpoint');
    }
    try {
        await registry.rememberPort(bound.port);
    } catch (error) {
        webSocketServer.close();
        await closeServer(server);
        throw error;
    }
    return bound.port;
};

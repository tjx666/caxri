import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';

import type { ServerControlEndpoint, ServerManifestIdentity } from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_FRAME_BYTES,
    CaxriError,
    CONTROL_TRANSPORT_MAX_FRAME_BYTES,
} from '@caxri/protocol';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import { fileSystemCode } from './control-server-support';

export interface ControlListener {
    endpoint: ServerControlEndpoint;
    server: Server;
    webSocketServers: readonly WebSocketServer[];
}

/**
 * Binds the local control plane exclusively to IPv4 loopback. Health and WebSocket upgrades share one listener so the
 * published endpoint, process probe, and authenticated control channel cannot drift to different instances.
 */
export async function listenForControlConnections(options: {
    identity: ServerManifestIdentity;
    onConnection(connection: WebSocket): void;
    onStreamConnection(connection: WebSocket, request: IncomingMessage): void;
}): Promise<ControlListener> {
    const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/healthz') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(
                JSON.stringify({
                    status: 'ok',
                    version: options.identity.version,
                    protocolVersion: options.identity.protocolVersion,
                }),
            );
            return;
        }
        response.writeHead(404);
        response.end();
    });
    const controlWebSocketServer = new WebSocketServer({
        maxPayload: CONTROL_TRANSPORT_MAX_FRAME_BYTES,
        noServer: true,
    });
    const streamWebSocketServer = new WebSocketServer({
        maxPayload: BINARY_STREAM_MAX_FRAME_BYTES,
        noServer: true,
    });
    server.on('upgrade', (request, socket, head) => {
        const webSocketServer =
            request.url === '/control'
                ? controlWebSocketServer
                : request.url === '/stream'
                  ? streamWebSocketServer
                  : undefined;
        if (!webSocketServer) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (connection) => {
            webSocketServer.emit('connection', connection, request);
        });
    });
    controlWebSocketServer.on('connection', (connection) => options.onConnection(connection));
    streamWebSocketServer.on('connection', (connection, request) =>
        options.onStreamConnection(connection, request),
    );
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => reject(error);
            server.once('error', onError);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', onError);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
            throw new CaxriError('IO', 'Host endpoint did not bind to loopback');
        return {
            endpoint: {
                protocol: 'ws',
                host: '127.0.0.1',
                port: address.port,
                path: '/control',
            },
            server,
            webSocketServers: [controlWebSocketServer, streamWebSocketServer],
        };
    } catch (error) {
        controlWebSocketServer.close();
        streamWebSocketServer.close();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (error instanceof CaxriError) throw error;
        if (fileSystemCode(error) === 'EADDRINUSE')
            throw new CaxriError('CONFLICT', 'Host endpoint is already in use');
        throw new CaxriError('IO', 'Host endpoint failed to listen');
    }
}

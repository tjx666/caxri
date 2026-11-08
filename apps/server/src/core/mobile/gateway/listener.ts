import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import {
    admitMobileTcpConnection,
    isAllowedMobilePeer,
    MAXIMUM_MOBILE_CONNECTIONS,
    mobileUpgradeFailure,
} from './admission';
import type { MobileGatewayFailureReason } from './diagnostics';

/**
 * Builds the gateway's unbound HTTP server and its WebSocket upgrade path. Every TCP connection, HTTP request, and
 * upgrade passes the private-network and capacity admission before any byte reaches the mobile handshake.
 */
export const createMobileGatewayListener = (options: {
    sourceAddress: (socket: Socket) => string | undefined;
    timeoutMs: number;
    /**
     * Plain-HTTP side channels (update downloads); returns whether it answered the request.
     */
    handleRequest: (request: IncomingMessage, response: ServerResponse) => boolean;
    canAdmitSource: (remoteAddress: string) => boolean;
    onRejected: (reason: MobileGatewayFailureReason) => void;
    tcpSockets: Set<Socket>;
    load: () => { connections: number; handshakes: number };
    onConnection: (socket: WebSocket, localAddress: string | undefined) => void;
}) => {
    const { sourceAddress, timeoutMs } = options;
    const webSocketServer = new WebSocketServer({
        maxPayload: MOBILE_GATEWAY_MAX_WIRE_BYTES,
        noServer: true,
        perMessageDeflate: false,
    });
    const server = createServer({ maxHeaderSize: 8 * 1_024 }, (request, response) => {
        if (!isAllowedMobilePeer(sourceAddress(request.socket), request.socket.localAddress)) {
            request.socket.destroy();
            return;
        }
        if (options.handleRequest(request, response)) return;
        response.writeHead(404, { Connection: 'close' }).end();
    });
    server.headersTimeout = timeoutMs;
    server.requestTimeout = timeoutMs;
    server.keepAliveTimeout = 1_000;
    server.maxConnections = MAXIMUM_MOBILE_CONNECTIONS;
    server.on('drop', () => options.onRejected('admissionCapacity'));
    server.on('connection', (socket) => {
        const remoteAddress = sourceAddress(socket);
        admitMobileTcpConnection(socket, {
            canAdmitSource: () => options.canAdmitSource(remoteAddress ?? 'unknown'),
            onRejected: options.onRejected,
            remoteAddress,
            sockets: options.tcpSockets,
            timeoutMs,
        });
    });
    server.on('upgrade', (request, socket, head) => {
        const { connections, handshakes } = options.load();
        const rejection = mobileUpgradeFailure(
            request,
            sourceAddress(request.socket),
            connections,
            handshakes,
        );
        if (rejection) {
            options.onRejected(rejection);
            socket.destroy();
            return;
        }
        (socket as Socket).setTimeout(0);
        webSocketServer.handleUpgrade(request, socket, head, (connection) => {
            webSocketServer.emit('connection', connection, request);
        });
    });
    webSocketServer.on('connection', (socket, request: IncomingMessage) =>
        options.onConnection(socket, request.socket.localAddress),
    );
    return { server, webSocketServer };
};

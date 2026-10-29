/**
 * The network paths to one paired computer and the race that picks one. Direct LAN or Tailscale addresses win whenever
 * they answer; the Relay is a fallback that starts only after a short grace, so a phone at home never pays the extra
 * hop.
 */
import type { RelayCloseReason } from '@caxri/mobile-transport';
import {
    decodeHex,
    encodeHex,
    PAIRING_SECRET_BYTES,
    RELAY_PROTOCOL_VERSION,
    relayAccessKey,
    relayClientConnectSchema,
    relayClientReadySchema,
    relayCloseReasonOf,
    relayEndpoint,
    relayPaths,
} from '@caxri/mobile-transport';

import { discardSocket, isSocketDiscarded } from './discard-socket';
import { MobilePairingError } from './mobile-gateway-errors';

/**
 * Slim runtime slice the race needs, so this module does not depend on the full gateway client.
 */
interface RouteRuntime {
    openWebSocket(url: string): WebSocket;
}

export type MobileGatewayRoute =
    | { kind: 'direct'; address: string; port: number }
    | { accessKey: Uint8Array; hostId: string; kind: 'relay'; url: string };

export type MobileGatewayRouteKind = MobileGatewayRoute['kind'];

const SOCKET_OPEN_TIMEOUT_MS = 4_000;
/**
 * How long direct candidates race alone before the Relay joins, matching Orca's and T3 Code's head start: long enough
 * for a LAN socket that answers at all, short enough that a phone away from home does not stare at a spinner.
 */
export const DIRECT_ROUTE_GRACE_MS = 2_500;
/**
 * The Relay answers `relay-ready` only after the computer dialed back, so this covers two Relay round trips plus the
 * Relay's own host dial-back deadline; a slower answer is a closed `host-timeout` from the Relay itself.
 */
const RELAY_READY_TIMEOUT_MS = 12_000;

/**
 * Why the Relay path failed. Relay-issued close codes keep their reason; the rest are local observations.
 */
export type MobileRelayFailureReason = RelayCloseReason | 'unexpected-frame' | 'unreachable';

/**
 * The Relay could not connect the phone. It stays a `MobilePairingError('unreachable')` so every caller keeps its
 * existing offline handling, while `reason` tells an offline computer from a rejected access key. An `unauthorized`
 * answer never clears the stored credential: the Relay may simply not have the computer's current grants yet.
 */
export class MobileRelayUnavailableError extends MobilePairingError {
    readonly reason: MobileRelayFailureReason;

    constructor(reason: MobileRelayFailureReason) {
        super('unreachable', 'Caxri could not be reached.');
        this.name = 'MobileRelayUnavailableError';
        this.reason = reason;
    }
}

export const gatewayRoutes = (input: {
    addresses: readonly string[];
    port: number;
    relay?: { accessKey: Uint8Array; hostId: string; url: string };
}): MobileGatewayRoute[] => [
    ...input.addresses.map((address) => ({ kind: 'direct' as const, address, port: input.port })),
    ...(input.relay ? [{ kind: 'relay' as const, ...input.relay }] : []),
];

/**
 * Routes to a paired computer. The Relay access key derives from the secret the handshake already uses: the pairing
 * secret while pairing, the device credential afterwards.
 */
export const pairedGatewayRoutes = (input: {
    addresses: readonly string[];
    port: number;
    purpose: 'device' | 'pairing';
    relay?: { hostId: string; url: string };
    secret: string;
}): MobileGatewayRoute[] =>
    gatewayRoutes({
        addresses: input.addresses,
        port: input.port,
        ...(input.relay && {
            relay: {
                url: input.relay.url,
                hostId: input.relay.hostId,
                accessKey: relayAccessKey(
                    decodeHex(input.secret, PAIRING_SECRET_BYTES),
                    input.purpose,
                ),
            },
        }),
    });

const unreachable = (): MobilePairingError =>
    new MobilePairingError('unreachable', 'Caxri could not be reached.');

const openDirectSocket = async (
    route: Extract<MobileGatewayRoute, { kind: 'direct' }>,
    runtime: RouteRuntime,
    onSocket: (socket: WebSocket) => void,
): Promise<WebSocket> => {
    const socket = runtime.openWebSocket(`ws://${route.address}:${route.port}/mobile`);
    onSocket(socket);
    await new Promise<void>((resolve, reject) => {
        const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
        function cleanup(): void {
            clearTimeout(timeout.handle);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onError);
        }
        function onError(): void {
            cleanup();
            discardSocket(socket);
            reject(unreachable());
        }
        function onOpen(): void {
            // A cancelled pairing's socket can still open on Android; it fails here and `discardSocket` closes it.
            if (isSocketDiscarded(socket)) {
                onError();
                return;
            }
            cleanup();
            resolve();
        }
        timeout.handle = setTimeout(onError, SOCKET_OPEN_TIMEOUT_MS);
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
        socket.addEventListener('close', onError, { once: true });
    });
    return socket;
};

/**
 * A Relay socket counts as open only after `relay-ready`: the Relay has checked the access key and spliced the
 * computer's dial-back, so the next frame the phone sends is the gateway hello. That first frame is consumed here,
 * before the gateway's socket reader exists.
 */
const isRelayReadyFrame = (data: unknown): boolean => {
    if (typeof data !== 'string') return false;
    try {
        return relayClientReadySchema.safeParse(JSON.parse(data)).success;
    } catch {
        return false;
    }
};

const openRelaySocket = async (
    route: Extract<MobileGatewayRoute, { kind: 'relay' }>,
    runtime: RouteRuntime,
    onSocket: (socket: WebSocket) => void,
): Promise<WebSocket> => {
    const socket = runtime.openWebSocket(relayEndpoint(route.url, relayPaths.client));
    onSocket(socket);
    await new Promise<void>((resolve, reject) => {
        const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
        function cleanup(): void {
            clearTimeout(timeout.handle);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('message', onMessage);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
        }
        function fail(reason: MobileRelayFailureReason): void {
            cleanup();
            discardSocket(socket);
            reject(new MobileRelayUnavailableError(reason));
        }
        function onError(): void {
            fail('unreachable');
        }
        function onClose(event: Event): void {
            const code = (event as CloseEvent).code;
            fail(
                (typeof code === 'number' ? relayCloseReasonOf(code) : undefined) ?? 'unreachable',
            );
        }
        function onOpen(): void {
            if (isSocketDiscarded(socket)) {
                onError();
                return;
            }
            try {
                const connect = relayClientConnectSchema.parse({
                    type: 'relay-connect',
                    version: RELAY_PROTOCOL_VERSION,
                    hostId: route.hostId,
                    accessKey: encodeHex(route.accessKey),
                });
                socket.send(JSON.stringify(connect));
            } catch {
                onError();
            }
        }
        function onMessage(event: Event): void {
            if (!isRelayReadyFrame((event as MessageEvent).data)) {
                fail('unexpected-frame');
                return;
            }
            if (isSocketDiscarded(socket)) {
                onError();
                return;
            }
            cleanup();
            resolve();
        }
        timeout.handle = setTimeout(onError, RELAY_READY_TIMEOUT_MS);
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('message', onMessage);
        socket.addEventListener('error', onError, { once: true });
        socket.addEventListener('close', onClose, { once: true });
    });
    return socket;
};

const openRouteSocket = (
    route: MobileGatewayRoute,
    runtime: RouteRuntime,
    onSocket: (socket: WebSocket) => void,
): Promise<WebSocket> =>
    route.kind === 'direct'
        ? openDirectSocket(route, runtime, onSocket)
        : openRelaySocket(route, runtime, onSocket);

export interface OpenedGatewaySocket {
    route: MobileGatewayRouteKind;
    socket: WebSocket;
}

/**
 * Races every route and keeps the first to open. Direct candidates start at once; Relay candidates join after
 * `DIRECT_ROUTE_GRACE_MS`, or immediately once every direct candidate failed. Only the winner ever carries a hello;
 * every other candidate is discarded, including one still connecting that React Native Android would otherwise leave
 * open. A Relay-specific failure is reported when it is the last reason left, so callers can tell an offline computer
 * from a dead network.
 */
export const openGatewaySocket = (
    routes: readonly MobileGatewayRoute[],
    runtime: RouteRuntime,
    directGraceMs = DIRECT_ROUTE_GRACE_MS,
): Promise<OpenedGatewaySocket> => {
    const direct = routes.filter((route) => route.kind === 'direct');
    const relay = routes.filter((route) => route.kind === 'relay');
    const sockets: WebSocket[] = [];
    return new Promise<OpenedGatewaySocket>((resolve, reject) => {
        let isSettled = false;
        let pending = 0;
        let directPending = direct.length;
        let didStartRelay = false;
        let lastRelayError: MobileRelayUnavailableError | undefined;
        const graceTimer: { handle?: ReturnType<typeof setTimeout> } = {};
        const settleFailure = (): void => {
            if (isSettled || pending > 0 || (!didStartRelay && relay.length > 0)) return;
            isSettled = true;
            reject(lastRelayError ?? unreachable());
        };
        const start = async (route: MobileGatewayRoute): Promise<void> => {
            pending += 1;
            let socket: WebSocket;
            try {
                socket = await openRouteSocket(route, runtime, (opened) => sockets.push(opened));
            } catch (error) {
                pending -= 1;
                if (error instanceof MobileRelayUnavailableError) lastRelayError = error;
                if (route.kind === 'direct') {
                    directPending -= 1;
                    if (directPending === 0) startRelay();
                }
                settleFailure();
                return;
            }
            pending -= 1;
            if (isSettled) {
                discardSocket(socket);
                return;
            }
            isSettled = true;
            clearTimeout(graceTimer.handle);
            for (const other of sockets) if (other !== socket) discardSocket(other);
            resolve({ route: route.kind, socket });
        };
        function startRelay(): void {
            if (didStartRelay || isSettled) return;
            didStartRelay = true;
            clearTimeout(graceTimer.handle);
            for (const route of relay) void start(route);
        }
        for (const route of direct) void start(route);
        if (relay.length > 0) {
            if (direct.length === 0) startRelay();
            else graceTimer.handle = setTimeout(startRelay, directGraceMs);
        }
        settleFailure();
    });
};

/**
 * Whether any direct address accepts a socket right now. The socket is discarded as soon as it opens and never carries
 * a hello, so the Server only sees a connection that closed before its handshake.
 */
export const isDirectRouteReachable = async (
    addresses: readonly string[],
    port: number,
    runtime: RouteRuntime,
): Promise<boolean> => {
    try {
        const { socket } = await openGatewaySocket(gatewayRoutes({ addresses, port }), runtime);
        discardSocket(socket);
        return true;
    } catch {
        return false;
    }
};

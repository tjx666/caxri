/**
 * The network paths to one paired computer and the race that picks one. Direct LAN or Tailscale addresses win whenever
 * they answer; the Relay is a fallback that asks for the computer only after a short grace, so a phone at home never
 * pays the extra hop. Its socket opens at once, though, so the slow TCP and TLS setup to the Relay overlaps the grace.
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
import type { SocketReader } from './socket-reader';
import { createSocketReader } from './socket-reader';

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
 * The head start left when the direct addresses are probably unreachable. A LAN socket that answers at all opens well
 * inside it, so a phone back home still connects directly, while a phone that is away waits a fraction of the full
 * grace.
 */
export const SHORT_DIRECT_ROUTE_GRACE_MS = 300;

/**
 * Tailscale's CGNAT range, the only stored address kind a phone on cellular data can still reach directly.
 */
const isTailnetAddress = (address: string): boolean => {
    const [first, second] = address.split('.').map(Number);
    return first === 100 && second >= 64 && second <= 127;
};

/**
 * How long direct candidates race alone. The full grace applies unless the Relay won last time for this computer, or
 * the phone is on cellular data and no stored address is on a tailnet.
 */
export const directRouteGraceFor = (input: {
    addresses: readonly string[];
    isCellular: boolean;
    lastRoute: MobileGatewayRouteKind | undefined;
}): number =>
    input.lastRoute === 'relay' ||
    (input.isCellular && input.addresses.every((address) => !isTailnetAddress(address)))
        ? SHORT_DIRECT_ROUTE_GRACE_MS
        : DIRECT_ROUTE_GRACE_MS;
/**
 * Counted from the moment the Relay is released, it covers opening the socket if it is still connecting, two Relay
 * round trips, and the Relay's own host dial-back deadline; a slower answer is a closed `host-timeout` from the Relay.
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

interface RelayLegOptions {
    /**
     * Resolves when the Relay may ask for the computer: after the direct grace, or once every direct route failed.
     */
    released: Promise<void>;
    /**
     * The gateway hello, sent right behind `relay-connect` so it crosses the phone's slow leg once instead of waiting
     * for `relay-ready`; the Relay holds it until the computer's socket is spliced.
     */
    hello?: () => string;
}

/**
 * A Relay socket counts as open only after `relay-ready`: the Relay has checked the access key and spliced the
 * computer's socket. The socket reader exists from the start, so a challenge that answers an early hello queues behind
 * `relay-ready` instead of arriving before anyone listens.
 */
const openRelaySocket = async (
    route: Extract<MobileGatewayRoute, { kind: 'relay' }>,
    runtime: RouteRuntime,
    onSocket: (socket: WebSocket) => void,
    options: RelayLegOptions,
): Promise<OpenedGatewaySocket> => {
    const socket = runtime.openWebSocket(relayEndpoint(route.url, relayPaths.client));
    onSocket(socket);
    const reader = createSocketReader(socket);
    let isHelloSent = false;
    await new Promise<void>((resolve, reject) => {
        let isDone = false;
        let isOpen = false;
        let isReleased = false;
        const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
        function cleanup(): void {
            isDone = true;
            clearTimeout(timeout.handle);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
        }
        function fail(reason: MobileRelayFailureReason): void {
            if (isDone) return;
            cleanup();
            reader.close();
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
        const awaitReady = async (): Promise<void> => {
            let frame: unknown;
            try {
                frame = await reader.next();
            } catch {
                // The socket's close or error listener reports why.
                return;
            }
            if (isDone) return;
            if (!relayClientReadySchema.safeParse(frame).success) {
                fail('unexpected-frame');
                return;
            }
            if (isSocketDiscarded(socket)) {
                onError();
                return;
            }
            cleanup();
            resolve();
        };
        function connect(): void {
            if (isDone || !isOpen || !isReleased) return;
            if (isSocketDiscarded(socket)) {
                onError();
                return;
            }
            try {
                const connectFrame = relayClientConnectSchema.parse({
                    type: 'relay-connect',
                    version: RELAY_PROTOCOL_VERSION,
                    hostId: route.hostId,
                    accessKey: encodeHex(route.accessKey),
                });
                socket.send(JSON.stringify(connectFrame));
                if (options.hello) {
                    socket.send(options.hello());
                    isHelloSent = true;
                }
            } catch {
                onError();
                return;
            }
            void awaitReady();
        }
        function onOpen(): void {
            isOpen = true;
            connect();
        }
        void options.released.then(() => {
            if (isDone) return;
            isReleased = true;
            timeout.handle = setTimeout(onError, RELAY_READY_TIMEOUT_MS);
            connect();
        });
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
        socket.addEventListener('close', onClose, { once: true });
    });
    return { route: 'relay', socket, reader, isHelloSent };
};

const openRouteSocket = async (
    route: MobileGatewayRoute,
    runtime: RouteRuntime,
    onSocket: (socket: WebSocket) => void,
    relayLeg: RelayLegOptions,
): Promise<OpenedGatewaySocket> =>
    route.kind === 'direct'
        ? { route: 'direct', socket: await openDirectSocket(route, runtime, onSocket) }
        : openRelaySocket(route, runtime, onSocket, relayLeg);

export interface OpenedGatewaySocket {
    /**
     * Whether the gateway hello already went out right behind `relay-connect`.
     */
    isHelloSent?: boolean;
    /**
     * The reader a Relay socket needed before its first frame; a direct socket's owner creates its own.
     */
    reader?: SocketReader;
    route: MobileGatewayRouteKind;
    socket: WebSocket;
}

/**
 * Races every route and keeps the first to open. Direct candidates start at once. Relay sockets open at once too, but
 * ask the Relay for the computer only after `DIRECT_ROUTE_GRACE_MS`, or as soon as every direct candidate failed. Every
 * other candidate is discarded, including one still connecting that React Native Android would otherwise leave open. A
 * Relay-specific failure is reported when it is the last reason left, so callers can tell an offline computer from a
 * dead network.
 */
export const openGatewaySocket = (
    routes: readonly MobileGatewayRoute[],
    runtime: RouteRuntime,
    directGraceMs = DIRECT_ROUTE_GRACE_MS,
    options: { relayHello?: () => string } = {},
): Promise<OpenedGatewaySocket> => {
    const directCount = routes.filter((route) => route.kind === 'direct').length;
    const hasRelay = routes.some((route) => route.kind === 'relay');
    const sockets: WebSocket[] = [];
    let openRelayLatch = (): void => {};
    // The Mobile runtime target is ES2022, without `Promise.withResolvers`.
    const released = new Promise<void>((resolve) => {
        openRelayLatch = resolve;
    });
    const relayLeg: RelayLegOptions = { released, hello: options.relayHello };
    return new Promise<OpenedGatewaySocket>((resolve, reject) => {
        let isSettled = false;
        let pending = 0;
        let directPending = directCount;
        let lastRelayError: MobileRelayUnavailableError | undefined;
        const graceTimer: { handle?: ReturnType<typeof setTimeout> } = {};
        const releaseRelay = (): void => {
            clearTimeout(graceTimer.handle);
            openRelayLatch();
        };
        const settleFailure = (): void => {
            if (isSettled || pending > 0) return;
            isSettled = true;
            clearTimeout(graceTimer.handle);
            reject(lastRelayError ?? unreachable());
        };
        const start = async (route: MobileGatewayRoute): Promise<void> => {
            pending += 1;
            let opened: OpenedGatewaySocket;
            try {
                opened = await openRouteSocket(
                    route,
                    runtime,
                    (socket) => sockets.push(socket),
                    relayLeg,
                );
            } catch (error) {
                pending -= 1;
                if (error instanceof MobileRelayUnavailableError) lastRelayError = error;
                if (route.kind === 'direct') {
                    directPending -= 1;
                    if (directPending === 0) releaseRelay();
                }
                settleFailure();
                return;
            }
            pending -= 1;
            if (isSettled) {
                opened.reader?.close();
                discardSocket(opened.socket);
                return;
            }
            isSettled = true;
            clearTimeout(graceTimer.handle);
            for (const other of sockets) if (other !== opened.socket) discardSocket(other);
            resolve(opened);
        };
        for (const route of routes) void start(route);
        if (hasRelay) {
            if (directCount === 0) releaseRelay();
            else graceTimer.handle = setTimeout(releaseRelay, directGraceMs);
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

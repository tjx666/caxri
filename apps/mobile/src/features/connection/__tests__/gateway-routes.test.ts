import {
    decodeHex,
    encodeHex,
    MOBILE_TRANSPORT_VERSION,
    PAIRING_SECRET_BYTES,
    relayAccessKey,
    relayCloseCodes,
    serializeMobilePairingLink,
} from '@caxri/mobile-transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobileGatewayRoute } from '../gateway-routes';
import {
    DIRECT_ROUTE_GRACE_MS,
    isDirectRouteReachable,
    MobileRelayUnavailableError,
    openGatewaySocket,
} from '../gateway-routes';
import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import {
    MobilePairingError,
    pairMobileGateway,
    reconnectMobileGateway,
} from '../mobile-gateway-client';
import {
    FakeGatewaySocket,
    flushTasks,
    memoryStore,
    mobileCredential,
    pairingSecret,
    serverId,
} from './mobile-gateway-fixture';

const relayUrl = 'wss://relay.example.com';
const hostId = 'cd'.repeat(16);
const accessKey = new Uint8Array(32).fill(9);
const relayRoute: MobileGatewayRoute = { kind: 'relay', url: relayUrl, hostId, accessKey };
const directRoute = (address: string): MobileGatewayRoute => ({
    kind: 'direct',
    address,
    port: 41_337,
});

/**
 * A socket the test drives by hand: open, deliver a frame, or close with a code.
 */
class ScriptedSocket extends EventTarget {
    readonly sent: string[] = [];
    isClosed = false;

    constructor(readonly url: string) {
        super();
    }

    open(): void {
        this.dispatchEvent(new Event('open'));
    }

    deliver(value: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }

    remoteClose(code: number): void {
        this.dispatchEvent(new CloseEvent('close', { code }));
    }

    fail(): void {
        this.dispatchEvent(new Event('error'));
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.isClosed = true;
    }
}

const scriptedRuntime = () => {
    const sockets: ScriptedSocket[] = [];
    return {
        sockets,
        byUrl: (fragment: string) => sockets.find((socket) => socket.url.includes(fragment)),
        runtime: {
            openWebSocket: (url: string) => {
                const socket = new ScriptedSocket(url);
                sockets.push(socket);
                return socket as unknown as WebSocket;
            },
        },
    };
};

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('Expected the promise to reject');
};

afterEach(() => {
    vi.useRealTimers();
});

describe('route race', () => {
    it('lets a direct address win before the Relay is ever dialed', async () => {
        const { byUrl, runtime, sockets } = scriptedRuntime();
        const opened = openGatewaySocket([directRoute('192.168.1.5'), relayRoute], runtime);
        byUrl('192.168.1.5')?.open();

        await expect(opened).resolves.toMatchObject({ route: 'direct' });
        expect(sockets).toHaveLength(1);
    });

    it('dials the Relay after the direct grace and keeps it once it is ready', async () => {
        vi.useFakeTimers();
        const { byUrl, runtime } = scriptedRuntime();
        const opened = openGatewaySocket([directRoute('192.168.1.5'), relayRoute], runtime);

        await vi.advanceTimersByTimeAsync(DIRECT_ROUTE_GRACE_MS - 1);
        expect(byUrl('relay.example.com')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        const relay = byUrl('relay.example.com')!;
        expect(relay.url).toBe('wss://relay.example.com/v1/client');

        relay.open();
        expect(JSON.parse(relay.sent[0])).toEqual({
            type: 'relay-connect',
            version: 1,
            hostId,
            accessKey: encodeHex(accessKey),
        });
        let isSettled = false;
        void opened.then(() => {
            isSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(isSettled).toBe(false);

        relay.deliver({ type: 'relay-ready', version: 1 });
        await expect(opened).resolves.toMatchObject({ route: 'relay' });
        expect(byUrl('192.168.1.5')?.isClosed).toBe(true);
    });

    it('dials the Relay at once when every direct address has already failed', async () => {
        vi.useFakeTimers();
        const { byUrl, runtime } = scriptedRuntime();
        const opened = openGatewaySocket(
            [directRoute('192.168.1.5'), directRoute('100.64.0.2'), relayRoute],
            runtime,
        );
        byUrl('192.168.1.5')?.fail();
        byUrl('100.64.0.2')?.fail();
        await vi.advanceTimersByTimeAsync(0);

        const relay = byUrl('relay.example.com');
        expect(relay).toBeDefined();
        relay!.open();
        relay!.deliver({ type: 'relay-ready', version: 1 });
        await expect(opened).resolves.toMatchObject({ route: 'relay' });
    });

    it.each([
        [relayCloseCodes['host-offline'], 'host-offline'],
        [relayCloseCodes.unauthorized, 'unauthorized'],
        [relayCloseCodes['host-timeout'], 'host-timeout'],
        [relayCloseCodes['rate-limited'], 'rate-limited'],
        [1006, 'unreachable'],
    ] as const)('reports Relay close %i as %s on the unreachable path', async (code, reason) => {
        const { byUrl, runtime } = scriptedRuntime();
        const opened = openGatewaySocket([relayRoute], runtime);
        byUrl('relay.example.com')?.open();
        byUrl('relay.example.com')?.remoteClose(code);

        const error = await failureOf(opened);
        expect(error).toBeInstanceOf(MobileRelayUnavailableError);
        expect(error).toBeInstanceOf(MobilePairingError);
        expect((error as MobilePairingError).code).toBe('unreachable');
        expect((error as MobileRelayUnavailableError).reason).toBe(reason);
    });

    it('rejects a Relay that answers with anything but relay-ready', async () => {
        const { byUrl, runtime } = scriptedRuntime();
        const opened = openGatewaySocket([relayRoute], runtime);
        const relay = byUrl('relay.example.com')!;
        relay.open();
        relay.deliver({ type: 'challenge' });

        await expect(opened).rejects.toMatchObject({ reason: 'unexpected-frame' });
        expect(relay.isClosed).toBe(true);
    });

    it('keeps the plain unreachable error when no Relay is configured', async () => {
        const { byUrl, runtime } = scriptedRuntime();
        const opened = openGatewaySocket([directRoute('192.168.1.5')], runtime);
        byUrl('192.168.1.5')?.fail();

        const error = await failureOf(opened);
        expect(error).toBeInstanceOf(MobilePairingError);
        expect(error).not.toBeInstanceOf(MobileRelayUnavailableError);
    });

    it('probes direct addresses without ever sending a frame', async () => {
        const { byUrl, runtime } = scriptedRuntime();
        const reachable = isDirectRouteReachable(['192.168.1.5'], 41_337, runtime);
        byUrl('192.168.1.5')?.open();

        await expect(reachable).resolves.toBe(true);
        expect(byUrl('192.168.1.5')?.sent).toEqual([]);
        expect(byUrl('192.168.1.5')?.isClosed).toBe(true);

        const unreachable = isDirectRouteReachable(['192.168.1.6'], 41_337, runtime);
        byUrl('192.168.1.6')?.fail();
        await expect(unreachable).resolves.toBe(false);
    });
});

/**
 * Relay front for the fixture gateway: answers `relay-connect` with `relay-ready`, then passes frames through.
 */
class RelayGatewaySocket extends FakeGatewaySocket {
    connect?: { accessKey: string; hostId: string };

    override send(source: string): void {
        if (this.connect) {
            super.send(source);
            return;
        }
        this.connect = JSON.parse(source) as { accessKey: string; hostId: string };
        queueMicrotask(() =>
            this.dispatchEvent(
                new MessageEvent('message', {
                    data: JSON.stringify({ type: 'relay-ready', version: 1 }),
                }),
            ),
        );
    }
}

describe('pairing and reconnecting through the Relay', () => {
    const unreachableDirect = (): WebSocket => {
        const socket = new EventTarget() as EventTarget & { close(): void; send(): void };
        socket.close = () => {};
        socket.send = () => {};
        queueMicrotask(() => socket.dispatchEvent(new Event('error')));
        return socket as unknown as WebSocket;
    };
    /**
     * Every direct address refuses, so the race dials the Relay at once.
     */
    const relayRuntime = () => {
        const relay: { current?: RelayGatewaySocket } = {};
        const runtime: MobileGatewayRuntime = {
            openWebSocket: (url) => {
                if (!url.startsWith('wss://')) return unreachableDirect();
                relay.current = new RelayGatewaySocket();
                return relay.current as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        return { relay, runtime };
    };

    it('pairs with the pairing access key and stores the Relay for later reconnects', async () => {
        const { relay, runtime } = relayRuntime();
        const { store } = memoryStore();
        const link = serializeMobilePairingLink({
            version: MOBILE_TRANSPORT_VERSION,
            addresses: ['192.168.1.5'],
            port: 41_337,
            serverId,
            pairingId: '11'.repeat(16),
            secret: pairingSecret,
            expiresAt: Date.now() + 60_000,
            relay: { url: relayUrl, hostId },
        });

        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink: link,
            runtime,
            store,
        });

        const pairingKey = relayAccessKey(
            decodeHex(pairingSecret, PAIRING_SECRET_BYTES),
            'pairing',
        );
        expect(relay.current?.connect).toMatchObject({ hostId, accessKey: encodeHex(pairingKey) });
        expect(paired.connection.route).toBe('relay');
        await expect(store.load()).resolves.toMatchObject({ relay: { url: relayUrl, hostId } });
        paired.connection.close('unmounted');
    });

    it('reconnects with the device access key and sends the connect hello through the Relay', async () => {
        const { byUrl, runtime: scripted } = scriptedRuntime();
        const runtime: MobileGatewayRuntime = {
            ...scripted,
            openWebSocket: (url) => {
                const socket = scripted.openWebSocket(url);
                if (url.startsWith('ws://')) queueMicrotask(() => byUrl(url)?.fail());
                return socket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const credential = { ...mobileCredential, relay: { url: relayUrl, hostId } };
        const { store } = memoryStore();
        await store.save(credential);

        const reconnected = failureOf(reconnectMobileGateway(credential, runtime, store));
        await flushTasks();
        const relay = byUrl('relay.example.com')!;
        relay.open();
        const deviceKey = relayAccessKey(
            decodeHex(mobileCredential.credential, PAIRING_SECRET_BYTES),
            'device',
        );
        expect(JSON.parse(relay.sent[0])).toMatchObject({ accessKey: encodeHex(deviceKey) });
        relay.deliver({ type: 'relay-ready', version: 1 });
        await flushTasks();
        expect(JSON.parse(relay.sent[1])).toMatchObject({ type: 'hello', mode: 'connect' });

        relay.remoteClose(1006);
        await expect(reconnected).resolves.toBeInstanceOf(Error);
        await expect(store.load()).resolves.toMatchObject({ relay: { url: relayUrl, hostId } });
    });
});

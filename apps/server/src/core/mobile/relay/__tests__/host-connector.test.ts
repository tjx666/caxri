import type { AddressInfo } from 'node:net';

import type { RelayGrant } from '@caxri/mobile-transport';
import {
    decodeHex,
    encodeHex,
    isRelayHostProofValid,
    RELAY_PROTOCOL_VERSION,
    relayCloseCodes,
    relayHostAcceptSchema,
    relayHostRegisterSchema,
    relayHostStandbySchema,
} from '@caxri/mobile-transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import { messageText } from '../../gateway/socket-message';
import { RelayHostConnector } from '../host-connector';

const SECRET_KEY = decodeHex('42'.repeat(32), 32);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

interface FakeHost {
    socket: WebSocket;
    nonce: string;
    frames: unknown[];
    next: () => Promise<unknown>;
}

/**
 * A minimal Relay double: issues a challenge on `/v1/host`, records frames, and lets each test decide the reply.
 */
async function fakeRelay(options: { autoPong?: boolean } = {}) {
    const server = new WebSocketServer({
        port: 0,
        host: '127.0.0.1',
        autoPong: options.autoPong ?? true,
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const hosts: FakeHost[] = [];
    const dataSockets: Array<{ socket: WebSocket; first: Promise<unknown> }> = [];
    let nonceByte = 1;
    server.on('connection', (socket, request) => {
        if (request.url === '/v1/host-data') {
            dataSockets.push({
                socket,
                first: new Promise((resolve) =>
                    socket.once('message', (data) => resolve(JSON.parse(messageText(data)))),
                ),
            });
            return;
        }
        const nonce = (nonceByte++).toString(16).padStart(2, '0').repeat(32);
        const frames: unknown[] = [];
        const waiting: Array<(frame: unknown) => void> = [];
        socket.on('message', (data) => {
            const frame = JSON.parse(messageText(data)) as unknown;
            const reader = waiting.shift();
            if (reader) reader(frame);
            else frames.push(frame);
        });
        const host: FakeHost = {
            socket,
            nonce,
            frames,
            next: () =>
                frames.length > 0
                    ? Promise.resolve(frames.shift())
                    : new Promise((resolve) => waiting.push(resolve)),
        };
        socket.send(
            JSON.stringify({ type: 'relay-challenge', version: RELAY_PROTOCOL_VERSION, nonce }),
        );
        hosts.push(host);
    });
    const port = (server.address() as AddressInfo).port;
    return {
        url: `ws://127.0.0.1:${port}`,
        dataSockets,
        /**
         * Resolves with the next host control socket to connect after this call.
         */
        nextHost: async (): Promise<FakeHost> => {
            const index = hosts.length;
            await vi.waitFor(() => expect(hosts.length).toBeGreaterThan(index));
            return hosts[index];
        },
        accept: async (host: FakeHost, hostId: string) => {
            const register = relayHostRegisterSchema.parse(await host.next());
            host.socket.send(
                JSON.stringify({
                    type: 'host-registered',
                    version: RELAY_PROTOCOL_VERSION,
                    hostId,
                }),
            );
            return register;
        },
        close: () =>
            new Promise<void>((resolve) => {
                for (const client of server.clients) client.terminate();
                server.close(() => resolve());
            }),
    };
}

const states = (write: ReturnType<typeof vi.fn>) =>
    write.mock.calls
        .filter(([, event]) => event === 'mobile_gateway.relay_state')
        .map((call) => (call[2] as { fields: Record<string, unknown> }).fields);

describe('RelayHostConnector', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        const pending = [...cleanups];
        cleanups.length = 0;
        await Promise.all(
            pending.map(async (cleanup) => {
                await cleanup();
            }),
        );
    });

    const setup = async (
        options: {
            autoPong?: boolean;
            canAccept?: () => boolean;
            grants?: () => Array<{ keyHash: string; expiresAt?: number }>;
            timing?: ConstructorParameters<typeof RelayHostConnector>[0]['timing'];
        } = {},
    ) => {
        const relay = await fakeRelay({ autoPong: options.autoPong });
        cleanups.push(() => relay.close());
        const write = vi.fn();
        const onConnection = vi.fn<(socket: WebSocket, dialMs: number) => void>();
        let grants: RelayGrant[] = [{ keyHash: KEY_A }];
        const connector = new RelayHostConnector({
            url: relay.url,
            secretKey: SECRET_KEY,
            grants: options.grants ?? (() => grants),
            canAccept: options.canAccept ?? (() => true),
            onConnection,
            logger: { write },
            random: () => 0,
            timing: { initialBackoffMs: 20, maxBackoffMs: 80, ...options.timing },
        });
        cleanups.push(() => connector.stop());
        return {
            connector,
            onConnection,
            relay,
            setGrants: (next: typeof grants) => {
                grants = next;
            },
            write,
        };
    };

    it('registers with a verifiable proof and the full grant set, then sends grant diffs', async () => {
        const { connector, relay, setGrants } = await setup();
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        const register = await relay.accept(host, connector.hostId);
        expect(
            isRelayHostProofValid({
                challenge: decodeHex(host.nonce, 32),
                publicKey: decodeHex(register.publicKey, 32),
                signature: decodeHex(register.signature, 64),
            }),
        ).toBe(true);
        expect(register.grants).toEqual([{ keyHash: KEY_A }]);
        await vi.waitFor(() => expect(connector.state).toBe('online'));

        setGrants([{ keyHash: KEY_B, expiresAt: Date.now() + 60_000 }]);
        connector.syncGrants();
        expect(await host.next()).toEqual({
            type: 'grant-update',
            add: [{ keyHash: KEY_B, expiresAt: expect.any(Number) as number }],
            remove: [KEY_A],
        });
        connector.syncGrants();
        setGrants([]);
        connector.syncGrants();
        expect(await host.next()).toEqual({ type: 'grant-update', add: [], remove: [KEY_B] });
    });

    it('leaves expired pairing grants out of the registration', async () => {
        const { connector, relay } = await setup({
            grants: () => [{ keyHash: KEY_A, expiresAt: Date.now() - 1 }, { keyHash: KEY_B }],
        });
        const hostArrived = relay.nextHost();
        connector.start();
        const register = await relay.accept(await hostArrived, connector.hostId);
        expect(register.grants).toEqual([{ keyHash: KEY_B }]);
    });

    it('lets an expired grant lapse on the Relay instead of removing it', async () => {
        let grants = [{ keyHash: KEY_A, expiresAt: Date.now() + 200 }];
        const { connector, relay } = await setup({ grants: () => grants });
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        await relay.accept(host, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        await new Promise((resolve) => setTimeout(resolve, 250));
        grants = [{ keyHash: KEY_B, expiresAt: Date.now() + 60_000 }];
        connector.syncGrants();
        expect(await host.next()).toEqual({
            type: 'grant-update',
            add: [{ keyHash: KEY_B, expiresAt: expect.any(Number) as number }],
            remove: [],
        });
    });

    it('dials back for an admitted phone and hands the spliced socket to the gateway', async () => {
        const { connector, onConnection, relay } = await setup();
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        await relay.accept(host, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        const incoming = { connectionId: 'c'.repeat(32), ticket: 'd'.repeat(64) };
        host.socket.send(JSON.stringify({ type: 'relay-incoming', ...incoming }));
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(1));
        expect(relayHostAcceptSchema.parse(await relay.dataSockets[0].first)).toEqual({
            type: 'host-accept',
            version: RELAY_PROTOCOL_VERSION,
            hostId: connector.hostId,
            ...incoming,
        });
        await vi.waitFor(() => expect(onConnection).toHaveBeenCalledOnce());
    });

    it('parks a standby socket, hands it over on relay-spliced with its first frame, and parks the next', async () => {
        const { connector, onConnection, relay } = await setup();
        const received: unknown[] = [];
        // The gateway attaches its listener inside `onConnection`, like the real one.
        onConnection.mockImplementation((socket) => {
            socket.on('message', (data) => received.push(JSON.parse(messageText(data))));
        });
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        expect(relayHostRegisterSchema.parse(await host.next())).toMatchObject({ standby: true });
        host.socket.send(
            JSON.stringify({
                type: 'host-registered',
                version: RELAY_PROTOCOL_VERSION,
                hostId: connector.hostId,
            }),
        );
        const ticket = 'e'.repeat(64);
        host.socket.send(JSON.stringify({ type: 'relay-standby', ticket }));
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(1));
        expect(relayHostStandbySchema.parse(await relay.dataSockets[0].first)).toEqual({
            type: 'host-standby',
            version: RELAY_PROTOCOL_VERSION,
            hostId: connector.hostId,
            ticket,
        });
        expect(onConnection).not.toHaveBeenCalled();

        const parked = relay.dataSockets[0].socket;
        parked.send(JSON.stringify({ type: 'relay-spliced', version: RELAY_PROTOCOL_VERSION }));
        parked.send(JSON.stringify({ hello: true }));
        await vi.waitFor(() => expect(received).toEqual([{ hello: true }]));
        expect(onConnection).toHaveBeenCalledWith(expect.anything(), 0);
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(2));
    });

    it('re-parks a standby socket the Relay dropped, after backoff', async () => {
        const { connector, onConnection, relay, write } = await setup();
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        await relay.accept(host, connector.hostId);
        host.socket.send(JSON.stringify({ type: 'relay-standby', ticket: 'e'.repeat(64) }));
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(1));
        await relay.dataSockets[0].first;
        relay.dataSockets[0].socket.terminate();
        await vi.waitFor(() =>
            expect(write).toHaveBeenCalledWith('warn', 'mobile_gateway.relay_dial_failed', {
                fields: { reason: 'standby-failed' },
            }),
        );
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(2));
        expect(onConnection).not.toHaveBeenCalled();
    });

    it('forgets earlier failed parks once a standby has stayed parked', async () => {
        // With `random` at 0 a retry waits half its ceiling: 100 ms after a forgiven failure, 200 ms otherwise.
        const { connector, relay } = await setup({
            timing: { initialBackoffMs: 200, maxBackoffMs: 10_000, stableAfterMs: 20 },
        });
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        await relay.accept(host, connector.hostId);
        host.socket.send(JSON.stringify({ type: 'relay-standby', ticket: 'e'.repeat(64) }));
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(1));
        await relay.dataSockets[0].first;
        relay.dataSockets[0].socket.terminate();
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(2), { timeout: 1_000 });
        await relay.dataSockets[1].first;
        await new Promise((resolve) => setTimeout(resolve, 60));
        const droppedAt = performance.now();
        relay.dataSockets[1].socket.terminate();
        await vi.waitFor(() => expect(relay.dataSockets).toHaveLength(3), { timeout: 1_000 });
        expect(performance.now() - droppedAt).toBeLessThan(170);
    });

    it('refuses a dial-back while the gateway is at capacity', async () => {
        const { connector, onConnection, relay, write } = await setup({ canAccept: () => false });
        const hostArrived = relay.nextHost();
        connector.start();
        const host = await hostArrived;
        await relay.accept(host, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        host.socket.send(
            JSON.stringify({
                type: 'relay-incoming',
                connectionId: 'c'.repeat(32),
                ticket: 'd'.repeat(64),
            }),
        );
        await vi.waitFor(() =>
            expect(write).toHaveBeenCalledWith('warn', 'mobile_gateway.relay_dial_failed', {
                fields: { reason: 'capacity' },
            }),
        );
        expect(relay.dataSockets).toHaveLength(0);
        expect(onConnection).not.toHaveBeenCalled();
    });

    it('records a rejected registration with its closed cause and reconnects with backoff', async () => {
        const { connector, relay, write } = await setup();
        const first = relay.nextHost();
        connector.start();
        const host = await first;
        await host.next();
        const second = relay.nextHost();
        host.socket.close(relayCloseCodes.unauthorized);
        const retry = await second;
        await relay.accept(retry, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        expect(states(write).map(({ state, cause }) => [state, cause].join(':'))).toEqual([
            'connecting:started',
            'offline:registration-rejected',
            'connecting:registration-rejected',
            'online:registered',
        ]);
    });

    it('names the Relay reason when the Relay closes a live registration', async () => {
        const { connector, relay, write } = await setup();
        const first = relay.nextHost();
        connector.start();
        const host = await first;
        await relay.accept(host, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        const second = relay.nextHost();
        host.socket.close(relayCloseCodes['shutting-down']);
        await second;
        expect(states(write)).toContainEqual(
            expect.objectContaining({
                state: 'offline',
                cause: 'closed-by-relay',
                relayReason: 'shutting-down',
                connectedMs: expect.any(Number) as number,
            }),
        );
        expect(connector.lastFailure).toBe('closed-by-relay');
    });

    it('exposes no failure until a registration is lost, and clears it once registered again', async () => {
        const { connector, relay } = await setup();
        const first = relay.nextHost();
        connector.start();
        expect(connector.lastFailure).toBeUndefined();
        const host = await first;
        await relay.accept(host, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        expect(connector.lastFailure).toBeUndefined();
        const second = relay.nextHost();
        host.socket.close(relayCloseCodes['shutting-down']);
        const next = await second;
        expect(connector.lastFailure).toBe('closed-by-relay');
        await relay.accept(next, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        expect(connector.lastFailure).toBeUndefined();
    });

    it('drops a registration whose pongs stop', async () => {
        const { connector, relay, write } = await setup({
            autoPong: false,
            timing: {
                pingIntervalMs: 10,
                pongTimeoutMs: 40,
                initialBackoffMs: 10_000,
                maxBackoffMs: 10_000,
            },
        });
        const first = relay.nextHost();
        connector.start();
        await relay.accept(await first, connector.hostId);
        await vi.waitFor(() =>
            expect(states(write)).toContainEqual(
                expect.objectContaining({ state: 'offline', cause: 'heartbeat-timeout' }),
            ),
        );
        expect(connector.lastFailure).toBe('heartbeat-timeout');
    });

    it('fails a registration whose Relay answers pings but never sends a challenge', async () => {
        const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));
        cleanups.push(
            () =>
                new Promise<void>((resolve) => {
                    for (const client of server.clients) client.terminate();
                    server.close(() => resolve());
                }),
        );
        let connections = 0;
        server.on('connection', () => (connections += 1));
        const write = vi.fn();
        const connector = new RelayHostConnector({
            url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
            secretKey: SECRET_KEY,
            grants: () => [],
            canAccept: () => true,
            onConnection: vi.fn(),
            logger: { write },
            random: () => 0,
            timing: {
                initialBackoffMs: 10,
                maxBackoffMs: 10,
                pingIntervalMs: 10,
                pongTimeoutMs: 10_000,
                registrationTimeoutMs: 50,
            },
        });
        cleanups.push(() => connector.stop());
        connector.start();
        await vi.waitFor(() =>
            expect(states(write)).toContainEqual(
                expect.objectContaining({ state: 'offline', cause: 'registration-timeout' }),
            ),
        );
        expect(connector.lastFailure).toBe('registration-timeout');
        await vi.waitFor(() => expect(connections).toBeGreaterThan(1));
    });

    it('fails a registration the Relay stalls after its challenge, then retries', async () => {
        const { connector, relay, write } = await setup({
            timing: { registrationTimeoutMs: 50, pongTimeoutMs: 10_000 },
        });
        const first = relay.nextHost();
        connector.start();
        await first;
        await vi.waitFor(() =>
            expect(states(write)).toContainEqual(
                expect.objectContaining({ state: 'offline', cause: 'registration-timeout' }),
            ),
        );
        expect(connector.lastFailure).toBe('registration-timeout');
        const second = relay.nextHost();
        await relay.accept(await second, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        expect(connector.lastFailure).toBeUndefined();
    });

    it('rejects a registration acknowledged for another host identity', async () => {
        const { connector, relay, write } = await setup({
            timing: { initialBackoffMs: 10_000, maxBackoffMs: 10_000 },
        });
        const first = relay.nextHost();
        connector.start();
        await relay.accept(await first, 'e'.repeat(32));
        await vi.waitFor(() =>
            expect(states(write)).toContainEqual(
                expect.objectContaining({ state: 'offline', cause: 'protocol-error' }),
            ),
        );
        expect(connector.state).toBe('offline');
    });

    it('stops reconnecting once stopped and never logs the Relay address or keys', async () => {
        const { connector, relay, write } = await setup();
        const first = relay.nextHost();
        connector.start();
        const host = await first;
        await relay.accept(host, connector.hostId);
        await vi.waitFor(() => expect(connector.state).toBe('online'));
        connector.stop();
        expect(connector.state).toBe('stopped');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(states(write).at(-1)).toMatchObject({ state: 'stopped', cause: 'disabled' });
        expect(
            write.mock.calls.filter(([, event]) => event === 'mobile_gateway.relay_state').length,
        ).toBe(3);
        const logged = JSON.stringify(write.mock.calls);
        expect(logged).not.toContain('127.0.0.1');
        expect(logged).not.toContain(KEY_A);
        expect(logged).not.toContain(encodeHex(SECRET_KEY));
    });
});

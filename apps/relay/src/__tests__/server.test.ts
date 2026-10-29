import { Buffer } from 'node:buffer';
import { connect } from 'node:net';

import { relayCloseCodes, relayEndpoint, relayPaths } from '@caxri/mobile-transport';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { StartedRelay } from './harness';
import {
    closed,
    connectClient,
    deviceAccess,
    FakeHost,
    opened,
    startRelay,
    waitFor,
} from './harness';

const device = deviceAccess(1);
const other = deviceAccess(2);
const running: StartedRelay[] = [];

const relayUp = async (overrides?: Parameters<typeof startRelay>[0]) => {
    const started = await startRelay(overrides);
    running.push(started);
    return started;
};

afterEach(async () => {
    const relays = running.map(({ relay }) => relay);
    running.length = 0;
    await Promise.all(relays.map((relay) => relay.close()));
});

describe('relay host registration', () => {
    it('splices a granted client to its host and echoes frames unchanged', async () => {
        const { baseUrl, lines, relay } = await relayUp();
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }]);

        const { socket, frames } = await connectClient(baseUrl, host.hostId, device.accessKey);
        expect(await frames.next()).toEqual({ type: 'relay-ready', version: 1 });
        socket.send(JSON.stringify({ hello: 'world' }));
        expect(await frames.next()).toEqual({ hello: 'world' });
        socket.send(Buffer.from([1, 2, 3]), { binary: true });
        expect([...((await frames.next()) as Buffer)]).toEqual([1, 2, 3]);
        expect(relay.stats()).toEqual({ hosts: 1, connections: 1 });

        const end = closed(host.dataSockets[0]!);
        socket.close(4001, 'heartbeat-timeout');
        expect(await end).toEqual({ code: 4001, reason: 'heartbeat-timeout' });
        await waitFor(() => lines.some((line) => line.event === 'relay.connection_ended'));
        const ended = lines.find((line) => line.event === 'relay.connection_ended')!;
        expect(ended).toMatchObject({ cause: 'client-closed', bytesUp: 20 });
        expect(JSON.stringify(lines)).not.toContain(device.accessKey);
        expect(JSON.stringify(lines)).not.toContain(host.hostId);
    });

    it('records heartbeat-timeout when a client stops answering pings', async () => {
        const { baseUrl, lines } = await relayUp({
            heartbeatIntervalMs: 20,
            heartbeatMissLimit: 2,
        });
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }]);
        // A silent peer: the client never answers the Relay's pings, as behind a NAT that dropped its mapping.
        const { frames } = await connectClient(baseUrl, host.hostId, device.accessKey, {
            autoPong: false,
        });
        expect(await frames.next()).toEqual({ type: 'relay-ready', version: 1 });
        await waitFor(() => lines.some((line) => line.event === 'relay.connection_ended'));
        expect(lines.find((line) => line.event === 'relay.connection_ended')).toMatchObject({
            cause: 'heartbeat-timeout',
        });
    });

    it('rejects a forged proof and replaces an older verified registration', async () => {
        const { baseUrl } = await relayUp();
        const host = new FakeHost(baseUrl);
        const forger = new FakeHost(baseUrl);
        // Signs with another host's secret key, so the proof cannot match the claimed public key.
        void forger.register([], host.key.secretKey);
        expect(await closed(forger.control)).toMatchObject({ code: relayCloseCodes.unauthorized });

        await host.register([{ keyHash: device.keyHash }]);
        const firstControl = host.control;
        const replacedClose = closed(firstControl);
        await host.register([{ keyHash: device.keyHash }]);
        expect(await replacedClose).toMatchObject({ code: relayCloseCodes.replaced });

        const { frames } = await connectClient(baseUrl, host.hostId, device.accessKey);
        expect(await frames.next()).toMatchObject({ type: 'relay-ready' });
    });
});

describe('relay client admission', () => {
    it('reports an unknown host as offline and an ungranted key as unauthorized', async () => {
        const { baseUrl } = await relayUp();
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }]);

        const offline = await connectClient(baseUrl, 'ab'.repeat(16), device.accessKey);
        expect(await closed(offline.socket)).toMatchObject({
            code: relayCloseCodes['host-offline'],
        });
        const denied = await connectClient(baseUrl, host.hostId, other.accessKey);
        expect(await closed(denied.socket)).toMatchObject({ code: relayCloseCodes.unauthorized });
    });

    it('expires pairing grants and closes clients whose host never dials back', async () => {
        const { baseUrl } = await relayUp({ hostDialTimeoutMs: 100 });
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash, expiresAt: Date.now() + 60_000 }]);
        host.dialBack = false;

        const waiting = await connectClient(baseUrl, host.hostId, device.accessKey);
        expect(await closed(waiting.socket)).toMatchObject({
            code: relayCloseCodes['host-timeout'],
        });

        host.updateGrants([{ keyHash: other.keyHash, expiresAt: Date.now() - 1 }], []);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const expired = await connectClient(baseUrl, host.hostId, other.accessKey);
        expect(await closed(expired.socket)).toMatchObject({ code: relayCloseCodes.unauthorized });
    });

    it('accepts each ticket once and only for its own host', async () => {
        const { baseUrl } = await relayUp();
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }]);
        host.dialBack = false;
        const client = await connectClient(baseUrl, host.hostId, device.accessKey);
        await waitFor(() => host.incoming.length === 1);
        const incoming = host.incoming[0]!;

        const wrongHost = await host.accept(incoming, 'cd'.repeat(16));
        expect(await closed(wrongHost)).toMatchObject({ code: relayCloseCodes.unauthorized });
        await host.accept(incoming);
        expect(await client.frames.next()).toMatchObject({ type: 'relay-ready' });
        const reused = await host.accept(incoming);
        expect(await closed(reused)).toMatchObject({ code: relayCloseCodes.unauthorized });
    });

    it('cuts live connections admitted with a removed grant', async () => {
        const { baseUrl } = await relayUp();
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }, { keyHash: other.keyHash }]);
        const revoked = await connectClient(baseUrl, host.hostId, device.accessKey);
        const kept = await connectClient(baseUrl, host.hostId, other.accessKey);
        await revoked.frames.next();
        await kept.frames.next();

        const revokedClose = closed(revoked.socket);
        host.updateGrants([], [device.keyHash]);
        expect(await revokedClose).toMatchObject({ code: relayCloseCodes.unauthorized });
        kept.socket.send(JSON.stringify({ still: 'open' }));
        expect(await kept.frames.next()).toEqual({ still: 'open' });
    });

    it('keeps spliced connections when the host control socket drops but fails pending ones', async () => {
        const { baseUrl } = await relayUp({ hostDialTimeoutMs: 5_000 });
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }]);
        const live = await connectClient(baseUrl, host.hostId, device.accessKey);
        await live.frames.next();
        host.dialBack = false;
        const pending = await connectClient(baseUrl, host.hostId, device.accessKey);
        await waitFor(() => host.incoming.length === 2);

        const pendingClose = closed(pending.socket);
        host.control.close();
        expect(await pendingClose).toMatchObject({ code: relayCloseCodes['host-offline'] });
        live.socket.send(JSON.stringify({ alive: true }));
        expect(await live.frames.next()).toEqual({ alive: true });
    });

    it('maps a vanished peer to peer-gone and enforces the per-source attempt budget', async () => {
        const { baseUrl } = await relayUp({ sourceAttemptsPerMinute: 2 });
        const host = new FakeHost(baseUrl);
        await host.register([{ keyHash: device.keyHash }]);
        const client = await connectClient(baseUrl, host.hostId, device.accessKey);
        await client.frames.next();
        const clientClose = closed(client.socket);
        host.dataSockets[0]!.terminate();
        expect(await clientClose).toMatchObject({ code: relayCloseCodes['peer-gone'] });

        const refused = new WebSocket(relayEndpoint(baseUrl, relayPaths.client));
        const outcome = await new Promise<string>((resolve) => {
            refused.once('unexpected-response', (_request, response) =>
                resolve(String(response.statusCode)),
            );
            refused.once('open', () => resolve('open'));
            refused.once('error', () => resolve('error'));
        });
        expect(outcome).toBe('429');
    });

    it('closes a socket that never sends its first frame', async () => {
        const { baseUrl } = await relayUp({ firstFrameTimeoutMs: 50 });
        const socket = new WebSocket(relayEndpoint(baseUrl, relayPaths.client));
        await opened(socket);
        expect(await closed(socket)).toMatchObject({ code: relayCloseCodes['invalid-request'] });
    });
});

describe('relay health', () => {
    it('reports counts without identifiers', async () => {
        const { baseUrl } = await relayUp();
        const response = await fetch(`${baseUrl.replace('ws:', 'http:')}${relayPaths.health}`);
        expect(await response.json()).toEqual({
            status: 'ok',
            protocolVersion: 1,
            hosts: 0,
            connections: 0,
        });
    });

    it('refuses an unparsable request target instead of crashing', async () => {
        const { baseUrl } = await relayUp();
        const { port } = new URL(baseUrl);
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = connect(Number(port), '127.0.0.1');
            let received = '';
            socket.on('data', (chunk) => (received += chunk.toString()));
            socket.on('close', () => resolve(received));
            socket.on('error', reject);
            socket.write(
                'GET http://%zz/ HTTP/1.1\r\nHost: relay\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
            );
        });
        expect(reply).toMatch(/^HTTP\/1\.1 404/u);
        const response = await fetch(`${baseUrl.replace('ws:', 'http:')}${relayPaths.health}`);
        expect(response.status).toBe(200);
    });

    it('closes every socket with shutting-down on close', async () => {
        const { baseUrl, relay } = await relayUp();
        const host = new FakeHost(baseUrl);
        await host.register([]);
        const hostClose = closed(host.control);
        running.length = 0;
        await relay.close();
        expect(await hostClose).toMatchObject({ code: relayCloseCodes['shutting-down'] });
    });
});

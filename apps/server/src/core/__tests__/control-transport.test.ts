import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    binaryStreamAuthorization,
    localServerReplySchema,
    localServerStreamTicketReplySchema,
    localServerWelcomeSchema,
    serverEndpointUrl,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type { BinaryStreamClaim } from '../binary-stream-control';
import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    const pending = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(pending.map((cleanup) => cleanup()));
});

async function fixture() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-control-transport-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    cleanups.push(async () => {
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    return lease;
}

async function connect(url: string): Promise<WebSocket> {
    const connection = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
        connection.once('open', resolve);
        connection.once('error', reject);
    });
    cleanups.push(() => {
        connection.terminate();
        return Promise.resolve();
    });
    return connection;
}

function nextJson(socket: WebSocket): Promise<unknown> {
    return new Promise((resolve) => {
        socket.once('message', (data) => {
            if (!Buffer.isBuffer(data)) throw new TypeError('Expected one buffered text message');
            resolve(JSON.parse(data.toString()) as unknown);
        });
    });
}

function closeEvent(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
}

describe('WebSocket control transport', () => {
    it('rejects bulk control commands without a negotiated legacy fallback', async () => {
        const lease = await fixture();
        const invoke = vi.fn();
        const server = new ControlServer({
            adapters: { server: { invoke } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const control = await connect(serverEndpointUrl(lease.manifest.endpoint));
        const welcome = nextJson(control);
        control.send(
            JSON.stringify({
                type: 'hello',
                clientId: 'desktop-no-bulk-control',
                supportedVersions: [2],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-no-bulk-control',
                },
            }),
        );
        const leaseGeneration = localServerWelcomeSchema.parse(await welcome).desktopLease!
            .generation;
        control.send(JSON.stringify({ type: 'desktop.ready', generation: leaseGeneration }));
        const bulkCommands: Array<[string, Record<string, unknown>]> = [
            ['files.read', { sessionId: 'session-1', path: '/project/file.txt' }],
            [
                'files.write',
                {
                    sessionId: 'session-1',
                    path: '/project/file.txt',
                    content: 'private-sentinel',
                },
            ],
            ['terminal.attach', { terminalId: 'terminal-1' }],
            ['terminal.input', { terminalId: 'terminal-1', data: 'private-input-sentinel' }],
            ['terminal.resize', { terminalId: 'terminal-1', cols: 80, rows: 24 }],
        ];
        for (const [index, [method, parameters]] of bulkCommands.entries()) {
            const replyMessage = nextJson(control);
            control.send(
                JSON.stringify({
                    type: 'command',
                    request: {
                        protocolVersion: 2,
                        id: `legacy-bulk-${index}`,
                        method,
                        params: parameters,
                    },
                }),
            );
            // eslint-disable-next-line no-await-in-loop -- each reply proves the preceding bulk command was rejected
            expect(localServerReplySchema.parse(await replyMessage)).toMatchObject({
                reply: {
                    id: `legacy-bulk-${index}`,
                    ok: false,
                    error: { code: 'VALIDATION' },
                },
            });
        }
        expect(invoke).not.toHaveBeenCalled();

        const leaked = vi.fn();
        control.on('message', leaked);
        server.broadcast({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'private-output-sentinel' },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(leaked).not.toHaveBeenCalled();
    });

    it('serves content-free health on the same loopback listener as control traffic', async () => {
        const lease = await fixture();
        const server = new ControlServer({
            adapters: { server: { invoke: () => null } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const { host, port } = lease.manifest.endpoint;

        const response = await fetch(`http://${host}:${port}/healthz`);
        const body: unknown = await response.json();
        const notFound = await fetch(`http://${host}:${port}/control`);
        await notFound.arrayBuffer();

        expect(response.status).toBe(200);
        expect(body).toEqual({ status: 'ok', version: '1.0.0', protocolVersion: 2 });
        expect(JSON.stringify(body)).not.toContain(lease.manifest.operatorToken);
        expect(notFound.status).toBe(404);
    });

    it('rejects binary control messages before authentication', async () => {
        const lease = await fixture();
        const invoke = vi.fn();
        const server = new ControlServer({
            adapters: { server: { invoke } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const connection = await connect(serverEndpointUrl(lease.manifest.endpoint));
        connection.send(
            Buffer.from(
                JSON.stringify({
                    type: 'hello',
                    clientId: 'client-test',
                    supportedVersions: [2],
                    profileId: lease.manifest.profileId,
                    credential: {
                        kind: 'operator',
                        token: lease.manifest.operatorToken,
                    },
                }),
            ),
        );

        await new Promise<void>((resolve) => connection.once('close', () => resolve()));
        expect(invoke).not.toHaveBeenCalled();
    });

    it('redeems a scoped stream ticket once and rejects an unknown bearer', async () => {
        const lease = await fixture();
        const claims: BinaryStreamClaim[] = [];
        const server = new ControlServer({
            adapters: {
                features: ['binary-streams-v1'],
                server: { invoke: () => null },
            },
            desktopCredential: lease.desktopCredential,
            handleBinaryStream: (socket, claim) => {
                claims.push(claim);
                socket.close(4000, 'completed');
            },
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
            },
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const control = await connect(serverEndpointUrl(lease.manifest.endpoint));
        const welcomeMessage = nextJson(control);
        control.send(
            JSON.stringify({
                type: 'hello',
                clientId: 'desktop-stream-test',
                supportedVersions: [2],
                features: ['binary-streams-v1'],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-stream-test',
                },
            }),
        );
        expect(localServerWelcomeSchema.parse(await welcomeMessage).features).toEqual([
            'binary-streams-v1',
        ]);
        const ticketMessage = nextJson(control);
        control.send(
            JSON.stringify({
                type: 'stream-ticket.request',
                protocolVersion: 2,
                id: 'stream-request-1',
                operation: { method: 'terminal.attach', terminalId: 'terminal-1' },
            }),
        );
        const reply = localServerStreamTicketReplySchema.parse(await ticketMessage);
        if (!reply.ok) throw new Error('Expected a binary stream ticket');
        const streamUrl = `ws://${lease.manifest.endpoint.host}:${lease.manifest.endpoint.port}${reply.grant.path}`;
        const stream = new WebSocket(streamUrl, {
            headers: { authorization: binaryStreamAuthorization(reply.grant.ticket) },
        });
        const completed = await closeEvent(stream);
        expect(completed).toEqual({ code: 4000, reason: 'completed' });
        expect(claims).toHaveLength(1);
        expect(claims[0].connectionId).toMatch(/^[0-9a-f]{32}$/u);
        expect(claims[0].operation).toEqual({
            method: 'terminal.attach',
            terminalId: 'terminal-1',
        });

        const reused = new WebSocket(streamUrl, {
            headers: { authorization: binaryStreamAuthorization(reply.grant.ticket) },
        });
        expect(await closeEvent(reused)).toEqual({ code: 4401, reason: 'unauthorized' });
        expect(claims).toHaveLength(1);
    });
});

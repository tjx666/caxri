import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serverEndpointUrl } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

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

describe('WebSocket control transport', () => {
    it('serves content-free health on the same loopback listener as control traffic', async () => {
        const lease = await fixture();
        const server = new ControlServer({
            adapters: { host: { invoke: () => null } },
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
            adapters: { host: { invoke } },
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
});

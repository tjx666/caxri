import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    CAXRI_PROTOCOL_VERSION,
    localServerEventSchema,
    localServerWelcomeSchema,
    type HostManifest,
} from '../../../packages/protocol/src';
import { HostClient, connectToHost } from '../../../packages/cli/src/host-client';
import { startHostApplication, type HostApplication } from '../application';

const runtimeFixture = `
const activePtyCount = 1;
const startedAt = Date.now();
process.on('message', (request) => {
    if (!request || typeof request !== 'object' || typeof request.id !== 'string') return;
    if (request.method === 'app.health') {
        process.send?.({
            id: request.id,
            ok: true,
            result: { ready: true, pid: process.pid, startedAt, activePtyCount },
        });
        return;
    }
    if (request.method === 'runtime.shutdown') {
        process.send?.({ id: request.id, ok: true, result: null });
        setTimeout(() => process.exit(0), 10);
        return;
    }
    process.send?.({
        id: request.id,
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Unsupported fixture method' },
    });
});
process.send?.({
    event: 'runtime.status',
    payload: { status: 'ready', restartCount: 0 },
});
`;

const mutationRaceRuntimeFixture = `
let activePtyCount = 0;
const startedAt = Date.now();
process.on('message', (request) => {
    if (!request || typeof request !== 'object' || typeof request.id !== 'string') return;
    if (request.method === 'app.health') {
        process.send?.({
            id: request.id,
            ok: true,
            result: { ready: true, pid: process.pid, startedAt, activePtyCount },
        });
        return;
    }
    if (request.method === 'terminal.input') {
        process.send?.({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.select' },
        });
        setTimeout(() => {
            activePtyCount = 1;
            process.send?.({ id: request.id, ok: true, result: null });
        }, 50);
        return;
    }
    if (request.method === 'runtime.shutdown') {
        process.send?.({ id: request.id, ok: true, result: null });
        setTimeout(() => process.exit(0), 10);
        return;
    }
    process.send?.({
        id: request.id,
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Unsupported fixture method' },
    });
});
process.send?.({
    event: 'runtime.status',
    payload: { status: 'ready', restartCount: 0 },
});
`;

const applications: HostApplication[] = [];
const directories: string[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(
        applications.splice(0).map((application) => application.stop('test-cleanup')),
    );
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

function lineReader(socket: Socket): () => Promise<unknown> {
    let source = '';
    const values: unknown[] = [];
    const readers: Array<(value: unknown) => void> = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        source += chunk;
        let newline = source.indexOf('\n');
        while (newline !== -1) {
            const value = JSON.parse(source.slice(0, newline)) as unknown;
            const reader = readers.shift();
            if (reader) reader(value);
            else values.push(value);
            source = source.slice(newline + 1);
            newline = source.indexOf('\n');
        }
    });
    return () => {
        const value = values.shift();
        return value === undefined
            ? new Promise<unknown>((resolve) => readers.push(resolve))
            : Promise.resolve(value);
    };
}

async function connectDesktop(manifest: HostManifest) {
    const socket = createConnection(manifest.endpoint);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const read = lineReader(socket);
    socket.write(
        `${JSON.stringify({
            type: 'hello',
            supportedVersions: [CAXRI_PROTOCOL_VERSION],
            profileId: manifest.profileId,
            ownerToken: manifest.ownerToken,
            clientKind: 'desktop',
        })}\n`,
    );
    localServerWelcomeSchema.parse(await read());
    return { read, socket };
}

async function waitForRemoval(path: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(path);
        } catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Host metadata removal: ${path}`);
}

describe('Headless Host application', () => {
    it('outlives client detach and requires confirmation before stopping a live PTY', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-host-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        await writeFile(runtimePath, runtimeFixture);
        const application = await startHostApplication({
            commit: 'test',
            executable: process.execPath,
            runtimePath,
            socketDirectory: process.platform === 'darwin' ? '/private/tmp' : '/tmp',
            userDataPath,
            version: '1.0.0',
        });
        applications.push(application);

        await expect(
            HostClient.connect({ ...application.lease.manifest, protocolVersion: 2 }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        const first = await connectToHost(userDataPath, 2_000);
        const health = await first.request('app.health');
        expect(health).toMatchObject({ ready: true, activePtyCount: 1 });
        first.close();

        const second = await connectToHost(userDataPath, 2_000);
        const status = await second.request('host.status');
        expect(status).toMatchObject({
            pid: process.pid,
            activePtyCount: 1,
            protocolCompatible: true,
        });
        expect(JSON.stringify(status)).not.toContain(application.lease.manifest.ownerToken);

        await expect(second.request('host.stop', { confirmLivePtys: false })).rejects.toMatchObject(
            { code: 'CONFLICT' },
        );
        await expect(access(application.lease.paths.manifest)).resolves.toBeUndefined();

        const confirmed = await second.request('host.stop', { confirmLivePtys: true });
        expect(confirmed).toMatchObject({ stopping: true, activePtyCount: 1 });
        await waitForRemoval(application.lease.paths.manifest);
        expect(await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8')).not.toContain(
            application.lease.manifest.ownerToken,
        );
    });

    it('closes mutation admission before evaluating an unconfirmed stop', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-stop-race-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        await writeFile(runtimePath, mutationRaceRuntimeFixture);
        const application = await startHostApplication({
            commit: 'test',
            executable: process.execPath,
            runtimePath,
            socketDirectory: process.platform === 'darwin' ? '/private/tmp' : '/tmp',
            userDataPath,
            version: '1.0.0',
        });
        applications.push(application);
        const desktop = await connectDesktop(application.lease.manifest);
        const operator = await connectToHost(userDataPath, 2_000);

        desktop.socket.write(
            `${JSON.stringify({
                type: 'command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'mutation-1',
                    method: 'terminal.input',
                    params: { terminalId: 'terminal-1', data: 'x' },
                },
            })}\n`,
        );
        localServerEventSchema.parse(await desktop.read());
        await expect(
            operator.request('host.stop', { confirmLivePtys: false }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(access(application.lease.paths.manifest)).resolves.toBeUndefined();

        await operator.request('host.stop', { confirmLivePtys: true });
        await waitForRemoval(application.lease.paths.manifest);
        operator.close();
    });

    it('finishes an accepted stop after the requesting client disconnects', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-stop-disconnect-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        await writeFile(runtimePath, runtimeFixture);
        const application = await startHostApplication({
            commit: 'test',
            executable: process.execPath,
            runtimePath,
            socketDirectory: process.platform === 'darwin' ? '/private/tmp' : '/tmp',
            userDataPath,
            version: '1.0.0',
        });
        applications.push(application);
        const desktop = await connectDesktop(application.lease.manifest);
        await new Promise<void>((resolve, reject) => {
            desktop.socket.write(
                `${JSON.stringify({
                    type: 'command',
                    request: {
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id: 'stop-disconnect',
                        method: 'host.stop',
                        params: { confirmLivePtys: true },
                    },
                })}\n`,
                (error) => {
                    if (error) reject(error);
                    else {
                        desktop.socket.destroy();
                        resolve();
                    }
                },
            );
        });

        await waitForRemoval(application.lease.paths.manifest);
    });
});

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
    if (request.method === 'project.queryForPrincipal') {
        process.send?.({
            id: request.id,
            ok: true,
            result: {
                view: request.params.principal.kind,
                projects: [{ id: 'project-1', displayTitle: 'Caxri', rootPath: '$HOME/code/caxri' }],
            },
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

const agentEndpointRuntimeFixture = `
import { writeFile } from 'node:fs/promises';
const startedAt = Date.now();
const launchId = 'launch-1';
process.on('message', async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'host-control.reply' && message.id === 'endpoint-begin') {
        await writeFile(process.env.CAXRI_ENDPOINT_FIXTURE_PATH, JSON.stringify(message.result));
        process.send?.({ event: 'runtime.status', payload: { status: 'ready', restartCount: 0 } });
        return;
    }
    if (typeof message.id !== 'string') return;
    if (message.method === 'app.health') {
        process.send?.({
            id: message.id,
            ok: true,
            result: { ready: true, pid: process.pid, startedAt, activePtyCount: 1 },
        });
        return;
    }
    if (message.method === 'project.queryForPrincipal') {
        process.send?.({
            id: message.id,
            ok: true,
            result: {
                view: message.params.principal.kind,
                projects: [{ id: 'project-1', displayTitle: 'Project' }],
            },
        });
        return;
    }
    if (message.method === 'terminal.close') {
        process.send?.({ id: message.id, ok: true, result: null });
        return;
    }
    if (message.method === 'runtime.shutdown') {
        process.send?.({ id: message.id, ok: true, result: null });
        setTimeout(() => process.exit(0), 10);
        return;
    }
    process.send?.({
        id: message.id,
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Unsupported fixture method' },
    });
});
process.send?.({
    type: 'host-control.request',
    id: 'endpoint-begin',
    operation: 'agent-endpoint.begin',
    params: {
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        provider: 'codex',
        launchId,
        name: 'Codex',
        permissionClass: 'standard',
        deliveryMode: 'unavailable',
    },
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

async function connectDesktop(manifest: HostManifest, desktopToken: string) {
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
            credential: { kind: 'desktop', token: desktopToken, desktopId: 'desktop-test' },
        })}\n`,
    );
    const welcome = localServerWelcomeSchema.parse(await read());
    if (!welcome.desktopLease) throw new Error('Desktop fixture did not receive a lease');
    socket.write(
        `${JSON.stringify({
            type: 'desktop.ready',
            generation: welcome.desktopLease.generation,
        })}\n`,
    );
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
    it('binds an Agent principal to one Runtime-owned PTY generation and retires it before close', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-agent-endpoint-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        const endpointFixturePath = join(userDataPath, 'endpoint-fixture.json');
        await writeFile(runtimePath, agentEndpointRuntimeFixture);
        const application = await startHostApplication({
            commit: 'test',
            executable: process.execPath,
            runtimeEnvironment: { CAXRI_ENDPOINT_FIXTURE_PATH: endpointFixturePath },
            runtimePath,
            socketDirectory: process.platform === 'darwin' ? '/private/tmp' : '/tmp',
            userDataPath,
            version: '1.0.0',
        });
        applications.push(application);
        const endpoint = JSON.parse(await readFile(endpointFixturePath, 'utf8')) as {
            ref: { hostId: string; endpointId: string; generation: number };
            token: string;
        };
        const agent = await HostClient.connect(application.lease.manifest, 2_000, {
            kind: 'agent',
            ...endpoint.ref,
            token: endpoint.token,
        });

        await expect(agent.request('agent.context')).resolves.toMatchObject({
            endpoint: {
                ref: endpoint.ref,
                projectId: 'project-1',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
            },
        });
        await expect(agent.request('agent.list')).resolves.toMatchObject({
            agents: [expect.objectContaining({ ref: endpoint.ref })],
        });
        await expect(agent.request('project.query', { mode: 'current' })).resolves.toEqual({
            view: 'agent',
            projects: [{ id: 'project-1', displayTitle: 'Project' }],
        });

        const desktop = await connectDesktop(
            application.lease.manifest,
            application.lease.desktopCredential.desktopToken,
        );
        desktop.socket.write(
            `${JSON.stringify({
                type: 'command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'close-agent',
                    method: 'terminal.close',
                    params: { terminalId: 'terminal-1' },
                },
            })}\n`,
        );
        await expect(desktop.read()).resolves.toMatchObject({
            type: 'reply',
            reply: { id: 'close-agent', ok: true },
        });
        await expect(agent.request('agent.context')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8')).not.toContain(
            endpoint.token,
        );
        agent.close();
    });

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
        await expect(first.request('project.query', { mode: 'list' })).resolves.toEqual({
            view: 'human-cli',
            projects: [{ id: 'project-1', displayTitle: 'Caxri', rootPath: '$HOME/code/caxri' }],
        });
        first.close();

        const second = await connectToHost(userDataPath, 2_000);
        const status = await second.request('host.status');
        expect(status).toMatchObject({
            pid: process.pid,
            activePtyCount: 1,
            protocolCompatible: true,
        });
        expect(JSON.stringify(status)).not.toContain(application.lease.manifest.operatorToken);

        await expect(second.request('host.stop', { confirmLivePtys: false })).rejects.toMatchObject(
            { code: 'CONFLICT' },
        );
        await expect(access(application.lease.paths.manifest)).resolves.toBeUndefined();

        const confirmed = await second.request('host.stop', { confirmLivePtys: true });
        expect(confirmed).toMatchObject({ stopping: true, activePtyCount: 1 });
        await waitForRemoval(application.lease.paths.manifest);
        expect(await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8')).not.toContain(
            application.lease.manifest.operatorToken,
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
        const desktop = await connectDesktop(
            application.lease.manifest,
            application.lease.desktopCredential.desktopToken,
        );
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
        const desktop = await connectDesktop(
            application.lease.manifest,
            application.lease.desktopCredential.desktopToken,
        );
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

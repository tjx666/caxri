import { Buffer } from 'node:buffer';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { connectToHost, HostClient } from '@caxri/client/supervise';
import type { HostManifest } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    hostEndpointUrl,
    localServerEventSchema,
    localServerWelcomeSchema,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import type { HostApp } from '../app';
import { startHostApp } from '../app';

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
let endpointRef;
let endpointCredential;
const pendingDispatchWaits = new Map();
function dispatchReceipt(dispatchId) {
    const launch = {
        provider: 'codex',
        mode: 'fresh',
        executable: 'codex',
        argumentCount: 0,
        fingerprint: 'a'.repeat(64),
    };
    return {
        dispatchId,
        operation: 'start',
        status: 'running',
        projectId: 'project-1',
        sessionId: 'session-1',
        terminalId: 'terminal-2',
        provider: 'codex',
        requestedLaunch: launch,
        effectiveLaunch: launch,
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
    };
}
process.on('message', async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'host-control.reply' && message.id === 'endpoint-begin') {
        endpointRef = message.result.ref;
        endpointCredential = message.result;
        process.send?.({
            type: 'host-control.request',
            id: 'endpoint-activate',
            operation: 'agent-endpoint.activate',
            params: { ref: endpointRef, launchId },
        });
        return;
    }
    if (message.type === 'host-control.reply' && message.id === 'endpoint-activate') {
        if (!message.result.activated) throw new Error('Endpoint activation failed');
        await writeFile(process.env.CAXRI_ENDPOINT_FIXTURE_PATH, JSON.stringify(endpointCredential));
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
    if (message.method === 'session.workbenchRoot.reportCreated') {
        await writeFile(
            process.env.CAXRI_WORKTREE_REPORT_FIXTURE_PATH,
            JSON.stringify(message.params),
        );
        process.send?.({
            id: message.id,
            ok: true,
            result: { status: 'accepted', action: 'candidate' },
        });
        return;
    }
    if (message.method === 'agent.dispatch.startInternal') {
        process.send?.({
            id: message.id,
            ok: true,
            result: dispatchReceipt(message.params.dispatchId),
        });
        return;
    }
    if (message.method === 'agent.dispatch.statusInternal') {
        process.send?.({
            id: message.id,
            ok: true,
            result: dispatchReceipt(message.params.dispatchId),
        });
        return;
    }
    if (message.method === 'agent.dispatch.waitInternal') {
        pendingDispatchWaits.set(message.params.waitId, message.id);
        if (process.env.CAXRI_DISPATCH_WAIT_FIXTURE_PATH)
            await writeFile(process.env.CAXRI_DISPATCH_WAIT_FIXTURE_PATH, message.params.waitId);
        return;
    }
    if (message.method === 'agent.dispatch.cancelWaitInternal') {
        const pendingId = pendingDispatchWaits.get(message.params.waitId);
        if (pendingId) {
            pendingDispatchWaits.delete(message.params.waitId);
            process.send?.({
                id: pendingId,
                ok: true,
                result: {
                    receipt: dispatchReceipt('dispatch-wait'),
                    outcome: 'canceled',
                },
            });
        }
        if (process.env.CAXRI_DISPATCH_CANCEL_FIXTURE_PATH)
            await writeFile(process.env.CAXRI_DISPATCH_CANCEL_FIXTURE_PATH, message.params.waitId);
        process.send?.({ id: message.id, ok: true, result: { canceled: Boolean(pendingId) } });
        return;
    }
    if (
        message.method === 'agent.control.interruptInternal' ||
        message.method === 'agent.control.stopInternal'
    ) {
        process.send?.({
            id: message.id,
            ok: true,
            result: {
                endpoint: endpointRef,
                terminalId: 'terminal-1',
                outcome: 'signaled',
            },
        });
        return;
    }
    if (message.method === 'terminal.sendInternal') {
        process.send?.({
            id: message.id,
            ok: true,
            result: {
                terminalId: message.params.terminalId,
                accepted: true,
                byteLength: Buffer.byteLength(message.params.text),
                enter: message.params.enter,
            },
        });
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
        messaging: {
            deliveryMode: 'unavailable',
            health: 'unsupported',
            reason: 'adapter_unavailable',
            checkedAt: 1,
            nextAction: 'restart_terminal',
        },
    },
});
`;

const apps: HostApp[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
    const socketsToClose = sockets.slice();
    sockets.length = 0;
    for (const socket of socketsToClose) socket.terminate();

    const appsToStop = apps.slice();
    apps.length = 0;
    await Promise.all(appsToStop.map((app) => app.stop('test-cleanup')));

    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

function messageReader(socket: WebSocket): () => Promise<unknown> {
    const values: unknown[] = [];
    const readers: Array<(value: unknown) => void> = [];
    socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new TypeError('Expected one buffered text message');
        const value = JSON.parse(data.toString()) as unknown;
        const reader = readers.shift();
        if (reader) reader(value);
        else values.push(value);
    });
    return () => {
        const value = values.shift();
        if (value !== undefined) return Promise.resolve(value);
        return new Promise<unknown>((resolve) => {
            readers.push(resolve);
        });
    };
}

async function connectDesktop(manifest: HostManifest, desktopToken: string) {
    const socket = new WebSocket(hostEndpointUrl(manifest.endpoint));
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    const read = messageReader(socket);
    socket.send(
        `${JSON.stringify({
            type: 'hello',
            supportedVersions: [CAXRI_PROTOCOL_VERSION],
            profileId: manifest.profileId,
            credential: { kind: 'desktop', token: desktopToken, desktopId: 'desktop-test' },
        })}\n`,
    );
    const welcome = localServerWelcomeSchema.parse(await read());
    if (!welcome.desktopLease) throw new Error('Desktop fixture did not receive a lease');
    socket.send(
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
            // Each attempt must observe the outcome of the previous poll before deciding
            // whether to retry, so the polling cannot be parallelized.
            // eslint-disable-next-line no-await-in-loop -- sequential polling by design
            await access(path);
        } catch {
            return;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential retry backoff by design
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Host metadata removal: ${path}`);
}

async function waitForFile(path: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            // Each attempt must observe the outcome of the previous poll before deciding
            // whether to retry, so the polling cannot be parallelized.
            // eslint-disable-next-line no-await-in-loop -- sequential polling by design
            await access(path);
            return;
        } catch {
            // eslint-disable-next-line no-await-in-loop -- sequential retry backoff by design
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw new Error(`Timed out waiting for fixture output: ${path}`);
}

describe('Headless Host application', () => {
    it('serves domain operations inside the Server Core process', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-core-'));
        directories.push(userDataPath);
        const app = await startHostApp({
            commit: 'test',
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const operator = await connectToHost(userDataPath, 2_000);

        await expect(operator.request('app.health')).resolves.toMatchObject({
            activePtyCount: 0,
            pid: process.pid,
            ready: true,
        });
        await expect(operator.request('host.status')).resolves.toMatchObject({
            pid: process.pid,
            runtimePid: process.pid,
        });

        operator.close();
    });

    it('binds an Agent principal to one Runtime-owned PTY generation and retires it before close', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-agent-endpoint-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        const endpointFixturePath = join(userDataPath, 'endpoint-fixture.json');
        const worktreeReportFixturePath = join(userDataPath, 'worktree-report.json');
        await writeFile(runtimePath, agentEndpointRuntimeFixture);
        const app = await startHostApp({
            commit: 'test',
            executable: process.execPath,
            runtimeEnvironment: {
                CAXRI_ENDPOINT_FIXTURE_PATH: endpointFixturePath,
                CAXRI_WORKTREE_REPORT_FIXTURE_PATH: worktreeReportFixturePath,
            },
            runtimePath,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const endpoint = JSON.parse(await readFile(endpointFixturePath, 'utf8')) as {
            ref: { hostId: string; endpointId: string; generation: number };
            token: string;
        };
        const agent = await HostClient.connect(app.lease.manifest, 2_000, {
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
        await expect(
            agent.request('agent.worktree.created', { rootPath: '/projects/created-worktree' }),
        ).resolves.toEqual({ status: 'accepted', action: 'candidate' });
        expect(JSON.parse(await readFile(worktreeReportFixturePath, 'utf8'))).toMatchObject({
            endpoint: {
                ref: endpoint.ref,
                projectId: 'project-1',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
            },
            rootPath: '/projects/created-worktree',
        });
        expect(agent.welcome.commands).toContain('agent.dispatch.status');
        expect(agent.welcome.commands).not.toContain('agent.dispatch.start');
        expect(agent.welcome.commands).not.toContain('agent.control.interrupt');
        expect(agent.welcome.commands).not.toContain('terminal.send');
        await expect(
            agent.request('agent.dispatch.status', { dispatchId: 'dispatch-readable' }),
        ).resolves.toMatchObject({ dispatchId: 'dispatch-readable', projectId: 'project-1' });
        await expect(
            agent.request('agent.dispatch.start', {
                projectId: 'project-1',
                sessionId: 'session-1',
                provider: 'codex',
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(agent.request('project.query', { mode: 'current' })).resolves.toEqual({
            view: 'agent',
            projects: [{ id: 'project-1', displayTitle: 'Project' }],
        });

        const desktop = await connectDesktop(
            app.lease.manifest,
            app.lease.desktopCredential.desktopToken,
        );
        const operator = await connectToHost(userDataPath, 2_000);
        await operator.request('agent.grant', {
            endpoint: endpoint.ref,
            policy: 'agent:control',
            ttlMs: 60_000,
        });
        const agentDispatch = await agent.requestWithId(
            'shared-dispatch-request',
            'agent.dispatch.start',
            {
                projectId: 'project-1',
                sessionId: 'session-1',
                provider: 'codex',
            },
        );
        expect(agentDispatch).toMatchObject({ operation: 'start', status: 'running' });
        const operatorDispatch = await operator.requestWithId(
            'shared-dispatch-request',
            'agent.dispatch.start',
            {
                projectId: 'project-1',
                sessionId: 'session-1',
                provider: 'codex',
            },
        );
        expect(operatorDispatch.dispatchId).not.toBe(agentDispatch.dispatchId);
        expect(agentDispatch.dispatchId).not.toBe('shared-dispatch-request');
        await expect(
            agent.request('agent.control.interrupt', { endpoint: endpoint.ref }),
        ).resolves.toMatchObject({ outcome: 'signaled', terminalId: 'terminal-1' });
        await expect(
            agent.request('agent.control.interrupt', {
                endpoint: { ...endpoint.ref, generation: endpoint.ref.generation + 1 },
            }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await expect(
            agent.request('terminal.send', {
                terminalId: 'terminal-1',
                text: 'agent must not steer',
                enter: true,
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
            operator.request('terminal.send', {
                terminalId: 'terminal-1',
                text: 'human steer',
                enter: true,
            }),
        ).resolves.toMatchObject({ accepted: true, byteLength: 11 });
        desktop.socket.send(
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
        // The logger now drains writes asynchronously, so first poll for the sentinel
        // `terminal.human_steer` record (emitted by the `operator.request('terminal.send', ...)`
        // above) to prove the log has been flushed to disk, then assert the token is absent.
        await vi.waitFor(async () => {
            const contents = await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8');
            expect(contents).toContain('terminal.human_steer');
        });
        expect(await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8')).not.toContain(
            endpoint.token,
        );
        operator.close();
        agent.close();
    });

    it('cancels a typed dispatch wait when its local Host client disconnects', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-dispatch-wait-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        const endpointFixturePath = join(userDataPath, 'endpoint-fixture.json');
        const waitFixturePath = join(userDataPath, 'dispatch-wait.txt');
        const cancelFixturePath = join(userDataPath, 'dispatch-cancel.txt');
        await writeFile(runtimePath, agentEndpointRuntimeFixture);
        const app = await startHostApp({
            commit: 'test',
            executable: process.execPath,
            runtimeEnvironment: {
                CAXRI_ENDPOINT_FIXTURE_PATH: endpointFixturePath,
                CAXRI_DISPATCH_WAIT_FIXTURE_PATH: waitFixturePath,
                CAXRI_DISPATCH_CANCEL_FIXTURE_PATH: cancelFixturePath,
            },
            runtimePath,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const operator = await connectToHost(userDataPath, 2_000);
        // The dispatch-wait request is intentionally not awaited here: it must stay pending
        // while the operator disconnects below, and is awaited later once cancellation is
        // observed. `.catch()` prevents an unhandled rejection in that interim window.
        const waiting = operator
            .request('agent.dispatch.wait', {
                dispatchId: 'dispatch-wait',
                afterRevision: 2,
                timeoutMs: 120_000,
            })
            // eslint-disable-next-line unicorn/prefer-await -- promise must be deferred, not awaited immediately
            .catch(() => {});
        await waitForFile(waitFixturePath);

        operator.close();

        await waitForFile(cancelFixturePath);
        await waiting;
        expect(await readFile(cancelFixturePath, 'utf8')).toBe(
            await readFile(waitFixturePath, 'utf8'),
        );
    });

    it('outlives client detach and requires confirmation before stopping a live PTY', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-host-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        await writeFile(runtimePath, runtimeFixture);
        const app = await startHostApp({
            commit: 'test',
            executable: process.execPath,
            runtimePath,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);

        await expect(
            HostClient.connect({ ...app.lease.manifest, protocolVersion: 1 }),
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
        expect(JSON.stringify(status)).not.toContain(app.lease.manifest.operatorToken);

        await expect(second.request('host.stop', { confirmLivePtys: false })).rejects.toMatchObject(
            { code: 'CONFLICT' },
        );
        await expect(access(app.lease.paths.manifest)).resolves.toBeUndefined();

        const confirmed = await second.request('host.stop', { confirmLivePtys: true });
        expect(confirmed).toMatchObject({ stopping: true, activePtyCount: 1 });
        await waitForRemoval(app.lease.paths.manifest);
        // The logger now drains writes asynchronously, so first poll for the sentinel
        // `host.stopped` record (emitted at the end of the `stop()` flow above) to prove the
        // log has been flushed to disk, then assert the token is absent.
        await vi.waitFor(async () => {
            const contents = await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8');
            expect(contents).toContain('host.stopped');
        });
        expect(await readFile(join(userDataPath, 'logs', 'host.jsonl'), 'utf8')).not.toContain(
            app.lease.manifest.operatorToken,
        );
    });

    it('closes mutation admission before evaluating an unconfirmed stop', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-stop-race-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        await writeFile(runtimePath, mutationRaceRuntimeFixture);
        const app = await startHostApp({
            commit: 'test',
            executable: process.execPath,
            runtimePath,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const desktop = await connectDesktop(
            app.lease.manifest,
            app.lease.desktopCredential.desktopToken,
        );
        const operator = await connectToHost(userDataPath, 2_000);

        desktop.socket.send(
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
        await expect(access(app.lease.paths.manifest)).resolves.toBeUndefined();

        await operator.request('host.stop', { confirmLivePtys: true });
        await waitForRemoval(app.lease.paths.manifest);
        operator.close();
    });

    it('finishes an accepted stop after the requesting client disconnects', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-stop-disconnect-'));
        directories.push(userDataPath);
        const runtimePath = join(userDataPath, 'runtime-child.mjs');
        await writeFile(runtimePath, runtimeFixture);
        const app = await startHostApp({
            commit: 'test',
            executable: process.execPath,
            runtimePath,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const desktop = await connectDesktop(
            app.lease.manifest,
            app.lease.desktopCredential.desktopToken,
        );
        await new Promise<void>((resolve, reject) => {
            desktop.socket.send(
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
                        desktop.socket.terminate();
                        resolve();
                    }
                },
            );
        });

        await waitForRemoval(app.lease.paths.manifest);
    });
});

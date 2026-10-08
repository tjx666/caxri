import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import type { CaxriError, CommandAdapter, ServerControlEndpoint } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    localServerWelcomeSchema,
    protocolFeatures,
    serverEndpointUrl,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { diagnosticsSnapshotFixture } from '../../__tests__/support/diagnostics-snapshot';
import { AgentEndpointRegistry } from '../agent-endpoints';
import { AgentInboxRegistry } from '../agent-inbox';
import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    const cleanupsToRun = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(cleanupsToRun.map((cleanup) => cleanup()));
});

async function profile() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-host-server-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    cleanups.push(async () => {
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    return lease;
}

function messageReader(socket: WebSocket) {
    const pending: Array<(value: unknown) => void> = [];
    socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new TypeError('Expected one buffered text message');
        pending.shift()?.(JSON.parse(data.toString()) as unknown);
    });
    return () =>
        new Promise<unknown>((resolve) => {
            pending.push(resolve);
        });
}

async function connect(endpoint: ServerControlEndpoint): Promise<WebSocket> {
    const socket = new WebSocket(serverEndpointUrl(endpoint));
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    cleanups.push(() => {
        socket.terminate();
        return Promise.resolve();
    });
    return socket;
}

describe('local Host transport', () => {
    it('deduplicates one mutation request ID across authenticated operator reconnects', async () => {
        const lease = await profile();
        const invoke = vi.fn((request: { method: string }) => {
            if (request.method !== 'settings.patch') return null;
            return {
                value: {
                    'session.defaultAgent': null,
                    'workbench.newWorktreeBehavior': 'ask',
                    'terminal.fontSize': 18,
                    'terminal.scrollback': 2_000,
                    'terminal.copyOnSelect': true,
                    'terminal.gpuAcceleration': 'off',
                    'terminal.osc52ClipboardWrite': false,
                    'files.maxFileBytes': 2_097_152,
                },
                revision: 'a'.repeat(64),
                errors: [],
                dryRun: false,
                changedKeys: ['terminal.fontSize'],
            };
        });
        const server = new ControlServer({
            adapters: { features: protocolFeatures, server: { invoke } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'c'.repeat(32),
                stateEpoch: 'd'.repeat(32),
            },
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const first = await ServerClient.connect(lease.manifest);
        expect(first.welcome.connection).toMatchObject({
            serverId: 'c'.repeat(32),
            bootId: lease.identity.processIdentity,
            stateEpoch: 'd'.repeat(32),
            clientId: `operator:${lease.identity.profileId}`,
        });
        await first.requestWithId('settings-retry', 'settings.patch', {
            changes: [{ key: 'terminal.fontSize', value: 18 }],
            dryRun: false,
        });
        first.close();
        const second = await ServerClient.connect(lease.manifest);
        expect(second.welcome.connection?.connectionId).not.toBe(
            first.welcome.connection?.connectionId,
        );
        await second.requestWithId('settings-retry', 'settings.patch', {
            changes: [{ key: 'terminal.fontSize', value: 18 }],
            dryRun: false,
        });
        const operatorEvents = vi.fn();
        second.onEvent(operatorEvents);
        server.broadcast({
            protocolVersion: 2,
            cursor: 1,
            event: {
                event: 'settings.changed',
                payload: { source: 'secret-sentinel' },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        second.close();

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(operatorEvents).not.toHaveBeenCalled();
    });

    it('authenticates in constant-shape handshake and dispatches a Host command', async () => {
        const lease = await profile();
        const host: CommandAdapter = {
            invoke: (request) => {
                if (request.method === 'app.health')
                    return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
                return null;
            },
        };
        const counts: number[] = [];
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            onClientCountChanged: (count) => {
                counts.push(count);
            },
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'client-test',
                supportedVersions: [2],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'operator',
                    token: lease.manifest.operatorToken,
                },
            })}\n`,
        );
        const welcome = localServerWelcomeSchema.parse(await read());
        expect(welcome.type).toBe('welcome');
        expect(welcome.principal.kind).toBe('human-cli');
        expect(welcome.capabilities).toEqual([
            'desktop.window',
            'diagnostics.read',
            'agents.read',
            'agents.control',
            'agents.dispatch',
            'agents.delegate',
            'agents.delegation.access',
            'agents.grant',
            'commander',
            'events.read',
            'host.read',
            'host.stop',
            'projects.read',
            'sessions.read',
            'settings.read',
            'settings.write',
            'settings.delegation.write',
            'terminals.read',
            'terminals.steer',
        ]);
        expect(welcome.commands).toContain('app.health');
        expect(welcome.commands).toContain('host.status');
        expect(welcome.commands).toContain('desktop.status');
        expect(welcome.commands).toContain('host.stop');
        expect(welcome.commands).toContain('project.query');
        expect(welcome.commands).toContain('settings.patch');
        expect(welcome.commands).toContain('logs.query');
        expect(welcome.commands).toContain('events.query');
        expect(welcome.commands).toContain('agent.list');
        expect(welcome.commands).toContain('agent.grant');
        expect(welcome.commands).toContain('agent.dispatch.start');
        expect(welcome.commands).toContain('agent.control.stop');
        expect(welcome.commands).toContain('terminal.send');
        expect(welcome.commands).not.toContain('agent.message.send');
        expect(welcome.commands).not.toContain('events.recover');
        socket.send(
            `${JSON.stringify({
                type: 'command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'health-1',
                    method: 'app.health',
                    params: {},
                },
            })}\n`,
        );
        await expect(read()).resolves.toMatchObject({
            type: 'reply',
            reply: { id: 'health-1', ok: true, result: { pid: 88 } },
        });
        expect(counts).toContain(1);
    });

    it('rejects the wrong profile token without invoking an application handler', async () => {
        const lease = await profile();
        const invoke = vi.fn();
        const server = new ControlServer({
            adapters: { server: { invoke } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const socket = await connect(lease.manifest.endpoint);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'client-test',
                supportedVersions: [2],
                profileId: lease.manifest.profileId,
                credential: { kind: 'operator', token: '0'.repeat(64) },
            })}\n`,
        );
        await new Promise<void>((resolve) => socket.once('close', () => resolve()));
        expect(invoke).not.toHaveBeenCalled();
    });

    it('authenticates Agent credentials and revalidates grants and generation per command', async () => {
        const lease = await profile();
        const token = 'ab'.repeat(32);
        const endpoints = new AgentEndpointRegistry(lease.identity.processIdentity, {
            token: () => token,
        });
        const endpoint = endpoints.begin({
            terminalId: 'terminal-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            provider: 'codex',
            launchId: 'launch-1',
            name: 'Codex',
            permissionClass: 'standard',
            messaging: {
                deliveryMode: 'unavailable',
                health: 'unsupported',
                reason: 'adapter_unavailable',
                checkedAt: 1,
                nextAction: 'restart_terminal',
            },
        });
        expect(endpoints.activate({ ref: endpoint.ref, launchId: 'launch-1' })).toBe(true);
        const server = new ControlServer({
            adapters: {
                server: {
                    invoke: (request, context) => {
                        if (request.method === 'agent.context') return endpoints.context(context);
                        if (request.method === 'diagnostics.snapshot')
                            return diagnosticsSnapshotFixture({
                                projectCount: 1,
                                sessionCount: 1,
                                terminalCount: 1,
                            });
                        return null;
                    },
                },
            },
            authenticateAgent: (credential) => endpoints.authenticate(credential),
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            refreshContext: (context) => endpoints.refresh(context),
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest, 2_000, {
            kind: 'agent',
            hostId: endpoint.ref.hostId,
            endpointId: endpoint.ref.endpointId,
            generation: endpoint.ref.generation,
            token,
        });

        expect(client.welcome.principal).toMatchObject({
            kind: 'agent',
            endpointId: endpoint.ref.endpointId,
            projectIds: ['project-1'],
        });
        expect(client.welcome.commands).not.toContain('diagnostics.snapshot');
        await expect(client.request('agent.context')).resolves.toMatchObject({ status: 'active' });
        endpoints.grant(endpoint.ref, 'debug:read', 60_000);
        await expect(client.request('diagnostics.snapshot')).resolves.toMatchObject({
            projectCount: 1,
        });
        expect(endpoints.retire({ ref: endpoint.ref, launchId: 'launch-1' })).toBe(true);
        await expect(client.request('agent.context')).rejects.toEqual(
            expect.objectContaining({ code: 'UNAVAILABLE' }) as CaxriError,
        );
        client.close();
    });

    it('confirms pull delivery after reply flush and requeues a disconnected long poll', async () => {
        const lease = await profile();
        const tokens = ['ab'.repeat(32), 'cd'.repeat(32)];
        const endpoints = new AgentEndpointRegistry(lease.identity.processIdentity, {
            token: () => tokens.shift()!,
        });
        const senderEndpoint = endpoints.begin({
            terminalId: 'terminal-sender',
            sessionId: 'session-1',
            projectId: 'project-1',
            provider: 'codex',
            launchId: 'launch-sender',
            name: 'Sender',
            permissionClass: 'standard',
            messaging: {
                deliveryMode: 'pull',
                health: 'ready',
                reason: 'pull_ready',
                checkedAt: 1,
                nextAction: 'use_pull',
            },
        });
        const receiverEndpoint = endpoints.begin({
            terminalId: 'terminal-receiver',
            sessionId: 'session-1',
            projectId: 'project-1',
            provider: 'codex',
            launchId: 'launch-receiver',
            name: 'Receiver',
            permissionClass: 'standard',
            messaging: {
                deliveryMode: 'pull',
                health: 'ready',
                reason: 'pull_ready',
                checkedAt: 1,
                nextAction: 'use_pull',
            },
        });
        expect(endpoints.activate({ ref: senderEndpoint.ref, launchId: 'launch-sender' })).toBe(
            true,
        );
        expect(endpoints.activate({ ref: receiverEndpoint.ref, launchId: 'launch-receiver' })).toBe(
            true,
        );
        const inbox = new AgentInboxRegistry(endpoints);
        let waitStartedResolve: (() => void) | undefined;
        const host: CommandAdapter = {
            invoke: (request, context, invocation) => {
                if (request.method === 'agent.message.send')
                    return inbox.send(context, request.params, invocation.requestId);
                if (request.method === 'agent.message.wait') {
                    waitStartedResolve?.();
                    return inbox.wait(context, request.params.timeoutMs, invocation.requestId);
                }
                if (request.method === 'agent.message.receipt')
                    return inbox.receipt(context, request.params.messageId);
                return null;
            },
        };
        const server = new ControlServer({
            adapters: { server: host },
            authenticateAgent: (credential) => endpoints.authenticate(credential),
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            onReplyFlushed: (request, reply, context) => {
                if (request.method !== 'agent.message.wait') return;
                if (reply.ok) inbox.confirmWait(request.id, context);
                else inbox.cancelWait(request.id);
            },
            onRequestDisconnected: (requestId) => inbox.cancelWait(requestId),
            refreshContext: (context) => endpoints.refresh(context),
        });
        await lease.publish(await server.start());
        cleanups.push(async () => {
            inbox.close();
            await server.close();
        });
        const sender = await ServerClient.connect(lease.manifest, 2_000, {
            kind: 'agent',
            ...senderEndpoint.ref,
            token: 'ab'.repeat(32),
        });
        const receiverCredential = {
            kind: 'agent' as const,
            ...receiverEndpoint.ref,
            token: 'cd'.repeat(32),
        };
        let receiver = await ServerClient.connect(lease.manifest, 2_000, receiverCredential);

        const first = await sender.request('agent.message.send', {
            to: receiverEndpoint.ref,
            body: 'flush-bound peer message',
        });
        await expect(
            receiver.request('agent.message.wait', { timeoutMs: 1_000 }),
        ).resolves.toMatchObject({ message: { body: 'flush-bound peer message' } });
        await vi.waitFor(async () => {
            await expect(
                sender.request('agent.message.receipt', { messageId: first.messageId }),
            ).resolves.toMatchObject({ status: 'delivered' });
        });

        const waitStarted = (() => {
            const { promise, resolve } = Promise.withResolvers<void>();
            waitStartedResolve = resolve;
            return promise;
        })();
        const abandoned = receiver.request('agent.message.wait', { timeoutMs: 2_000 });
        await waitStarted;
        receiver.close();
        await expect(abandoned).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        const second = await sender.request('agent.message.send', {
            to: receiverEndpoint.ref,
            body: 'requeued after disconnect',
        });
        receiver = await ServerClient.connect(lease.manifest, 2_000, receiverCredential);
        await expect(
            receiver.request('agent.message.wait', { timeoutMs: 1_000 }),
        ).resolves.toMatchObject({ message: { id: second.messageId } });

        sender.close();
        receiver.close();
    });

    it('does not let the operator credential self-assert the Desktop principal', async () => {
        const lease = await profile();
        const server = new ControlServer({
            adapters: { server: { invoke: vi.fn() } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const socket = await connect(lease.manifest.endpoint);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'desktop-test',
                supportedVersions: [2],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.manifest.operatorToken,
                    desktopId: 'desktop-test',
                },
            })}\n`,
        );

        await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    });

    it('fails closed when the client has no compatible protocol version', async () => {
        const lease = await profile();
        const server = new ControlServer({
            adapters: { server: { invoke: vi.fn() } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const socket = await connect(lease.manifest.endpoint);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'client-test',
                supportedVersions: [1],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'operator',
                    token: lease.manifest.operatorToken,
                },
            })}\n`,
        );
        await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    });

    it('routes reverse commands and transient events only to the current Desktop generation', async () => {
        const lease = await profile();
        const unavailable = vi.fn();
        const server = new ControlServer({
            adapters: {
                server: {
                    invoke: (request) =>
                        request.method === 'app.health'
                            ? { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 }
                            : null,
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            onDesktopUnavailable: unavailable,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const credential = lease.desktopCredential;
        const firstHandler = vi.fn(() => Promise.resolve(null));
        const secondHandler = vi.fn(() => Promise.resolve(null));
        const first = await ServerClient.connect(lease.manifest, 2_000, {
            kind: 'desktop',
            desktopId: 'desktop-first',
            credential,
            handleCommand: firstHandler,
        });
        const firstEvents = vi.fn();
        const firstClosed = vi.fn();
        first.onEvent(firstEvents);
        first.onClose(firstClosed);
        cleanups.push(() => {
            first.close();
            return Promise.resolve();
        });
        const second = await ServerClient.connect(lease.manifest, 2_000, {
            kind: 'desktop',
            desktopId: 'desktop-second',
            credential,
            handleCommand: secondHandler,
        });
        const secondEvents = vi.fn();
        second.onEvent(secondEvents);
        cleanups.push(() => {
            second.close();
            return Promise.resolve();
        });

        const secondGeneration = second.desktopLease!.generation;
        const ready = server.waitForDesktopLease(2_000);
        await expect(
            server.invokeDesktop({ kind: 'focus' }, secondGeneration),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await second.markDesktopReady();
        await expect(ready).resolves.toMatchObject({ generation: secondGeneration });
        await server.invokeDesktop({ kind: 'focus' }, secondGeneration);
        expect(firstHandler).not.toHaveBeenCalled();
        expect(secondHandler).toHaveBeenCalledWith({ kind: 'focus' }, expect.any(Function));
        // Lease replacement severs the replaced Desktop's connection instead of leaving it to
        // poll CONFLICT replies against a socket it no longer owns (GitHub issue #173).
        await expect(first.request('app.health')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        await vi.waitFor(() => expect(firstClosed).toHaveBeenCalled());
        expect(firstClosed.mock.calls[0]?.[0]).toBe('replaced');
        expect(server.clientCount()).toBe(1);
        server.broadcast({
            event: 'workbench.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'workbench-project-1',
                reason: 'selected',
            },
        });
        await vi.waitFor(() => expect(secondEvents).toHaveBeenCalledTimes(1));
        expect(firstEvents).not.toHaveBeenCalled();
        expect(unavailable).not.toHaveBeenCalled();

        second.close();
        await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1));
    });

    it('settles nested Desktop target redemption without deadlocking the command queue', async () => {
        const lease = await profile();
        const revealed = vi.fn();
        const server: ControlServer = new ControlServer({
            adapters: {
                server: {
                    invoke: async (request) => {
                        if (request.method !== 'files.reveal') return null;
                        const generation = server.desktopLease()?.generation;
                        if (!generation) throw new Error('Desktop lease is unavailable');
                        await server.invokeDesktop(
                            { kind: 'reveal', targetId: 'target-1' },
                            generation,
                        );
                        return {
                            state: 'revealed',
                            generation,
                            projectId: 'project-1',
                            sessionId: 'session-1',
                        };
                    },
                },
            },
            consumeDesktopTarget: (targetId) =>
                Promise.resolve({
                    targetId,
                    operation: 'reveal',
                    kind: 'file',
                    sessionId: 'session-1',
                    path: '/project/draft.txt',
                }),
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest, 250, {
            kind: 'desktop',
            desktopId: 'desktop-nested-target',
            credential: lease.desktopCredential,
            handleCommand: async (operation, consumeTarget) => {
                if (operation.kind !== 'reveal') return null;
                const target = await consumeTarget();
                revealed(target.path);
                return null;
            },
        });
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });
        await client.markDesktopReady();

        await expect(
            client.request('files.reveal', {
                sessionId: 'session-1',
                path: '/project/draft.txt',
                launchIfNeeded: false,
            }),
        ).resolves.toMatchObject({ state: 'revealed' });
        expect(revealed).toHaveBeenCalledWith('/project/draft.txt');
    });

    it('does not let a slow file stream block later Terminal streams', async () => {
        const lease = await profile();
        const { promise: slowRead, resolve: releaseRead } = Promise.withResolvers<unknown>();
        const invoke = vi.fn((request: { method: string }) => {
            if (request.method === 'files.read') return slowRead;
            if (request.method === 'terminal.input' || request.method === 'terminal.resize')
                return null;
            throw new Error(`Unexpected method: ${request.method}`);
        });
        const server = new ControlServer({
            adapters: { features: protocolFeatures, server: { invoke } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
            },
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest, 2_000, {
            kind: 'desktop',
            desktopId: 'desktop-terminal-priority',
            credential: lease.desktopCredential,
            handleCommand: () => Promise.resolve(null),
        });
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });

        await client.markDesktopReady();
        const slow = client.request('files.read', {
            sessionId: 'session-1',
            path: '/project/slow.ts',
        });
        await vi.waitFor(() =>
            expect(invoke).toHaveBeenCalledWith(
                expect.objectContaining({ method: 'files.read' }),
                expect.anything(),
                expect.anything(),
            ),
        );

        try {
            const input = client.request('terminal.input', {
                terminalId: 'terminal-1',
                data: 'x',
            });
            await vi.waitFor(() =>
                expect(invoke).toHaveBeenCalledWith(
                    expect.objectContaining({ method: 'terminal.input' }),
                    expect.anything(),
                    expect.anything(),
                ),
            );
            await expect(input).resolves.toBeNull();
            await expect(
                client.request('terminal.resize', {
                    terminalId: 'terminal-1',
                    cols: 120,
                    rows: 40,
                }),
            ).resolves.toBeNull();
        } finally {
            releaseRead({ path: '/project/slow.ts', content: '', mtimeMs: 1, size: 0 });
            await slow;
        }
    });

    it('keeps copy and write requests pending until their authoritative result arrives', async () => {
        const lease = await profile();
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: async (request) => {
                        if (request.method !== 'files.write') return null;
                        await new Promise((resolve) => setTimeout(resolve, 80));
                        return {
                            path: request.params.path,
                            content: request.params.content,
                            mtimeMs: 1,
                            size: request.params.content.length,
                        };
                    },
                },
            },
            protocolIdentity: {
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest, 40, {
            kind: 'desktop',
            desktopId: 'desktop-long-write',
            credential: lease.desktopCredential,
            handleCommand: () => Promise.resolve(null),
        });
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });

        await expect(
            client.request('files.write', {
                sessionId: 'session-1',
                path: '/project/file.ts',
                content: 'saved',
            }),
        ).resolves.toMatchObject({ path: '/project/file.ts', content: 'saved' });
    });
});

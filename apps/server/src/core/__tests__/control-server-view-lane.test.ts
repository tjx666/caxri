import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandAdapter, ServerControlEndpoint } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    localServerWelcomeSchema,
    serverEndpointUrl,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { ControlServer } from '../control-server';
import type { ControlServerOptions } from '../control-server-support';
import { acquireServerProfile } from '../profile';

/**
 * Split out of `control-server-regressions.test.ts` to keep both files under the repository's source-size budget. This
 * file owns the ordered and repository lane admission of Extension work specifically; the fixtures below (`profile`,
 * `connect`, `messageReader`, `command`) intentionally mirror the sibling files rather than being shared, matching
 * `control-server-desktop-lease-regressions.test.ts`.
 */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const cleanupsToRun = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(cleanupsToRun.map((cleanup) => cleanup()));
});

async function profile() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-host-regression-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    cleanups.push(async () => {
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    return lease;
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

function messageReader(socket: WebSocket) {
    const values: unknown[] = [];
    const pending: Array<{ reject(error: Error): void; resolve(value: unknown): void }> = [];
    socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new TypeError('Expected one buffered text message');
        const value = JSON.parse(data.toString()) as unknown;
        const waiter = pending.shift();
        if (waiter) waiter.resolve(value);
        else values.push(value);
    });
    socket.on('close', () => {
        const pendingToReject = pending.slice();
        pending.length = 0;
        for (const waiter of pendingToReject) waiter.reject(new Error('Socket closed'));
    });
    return () =>
        values.length > 0
            ? Promise.resolve(values.shift())
            : new Promise<unknown>((resolve, reject) => {
                  pending.push({ resolve, reject });
              });
}

function command(id: string, method: string, parameters: unknown) {
    return JSON.stringify({
        type: 'command',
        request: { protocolVersion: CAXRI_PROTOCOL_VERSION, id, method, params: parameters },
    });
}

describe('Extension work in the ordered and repository lanes', () => {
    const viewContext = {
        kind: 'session',
        sessionId: 'session-1',
        workbenchProjectId: 'project-1',
    } as const;

    async function connectDesktop(host: CommandAdapter, logger?: ControlServerOptions['logger']) {
        const lease = await profile();
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            ...(logger && { logger }),
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'desktop-view-lane',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-view-lane',
                },
            })}\n`,
        );
        localServerWelcomeSchema.parse(await read());
        return { read, socket };
    }

    /**
     * Production (0.0.95) logged a 9.8s `source.snapshot` whose nested Git summary held the Desktop lane, so
     * `commander.status` and `app.records` queued for the same 9.8s behind a read-only view operation.
     */
    it.each([
        ['badge.snapshot', {}],
        ['source.snapshot', { refresh: 0 }],
        ['source.historyPage', { historyId: 'history-1', revision: '1' }],
        ['source.historyDetails', { historyId: 'history-1', itemId: 'item-1', revision: '1' }],
    ] as const)(
        'settles a %s view read outside the ordered lane',
        async (operation, arguments_) => {
            const viewStarted = Promise.withResolvers<void>();
            const host: CommandAdapter = {
                invoke: async (request) => {
                    if (request.method === 'viewContainers.viewOperation') {
                        viewStarted.resolve();
                        await new Promise<never>(() => {});
                    }
                    return null;
                },
            };
            const { read, socket } = await connectDesktop(host);
            socket.send(
                command('view-hung', 'viewContainers.viewOperation', {
                    viewId: 'publisher.git.sourceControl',
                    requestId: 'view-request',
                    operation,
                    arguments: arguments_,
                    context: viewContext,
                }),
            );
            await viewStarted.promise;
            socket.send(command('records', 'app.records', {}));
            await expect(read()).resolves.toMatchObject({ reply: { id: 'records' } });
        },
    );

    const sourceAction = {
        viewId: 'publisher.git.sourceControl',
        requestId: 'view-request',
        operation: 'source.action',
        arguments: { actionId: 'action-1', revision: '1' },
        context: viewContext,
    } as const;
    const extensionCommand = {
        commandId: 'publisher.merge',
        arguments: [],
        context: viewContext,
    } as const;
    const switchBranch = {
        sessionId: 'session-1',
        repositoryId: 'repo-1',
        branch: 'main',
    } as const;

    /**
     * Holds the first invocation of `method` until `release` resolves and records every invocation in arrival order.
     */
    function blockingHost(method: string) {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const invoked: string[] = [];
        let hasBlocked = false;
        const host: CommandAdapter = {
            invoke: async (request) => {
                invoked.push(request.method);
                if (!hasBlocked && request.method === method) {
                    hasBlocked = true;
                    started.resolve();
                    await release.promise;
                }
                return request.method === 'viewContainers.executeCommand'
                    ? { executed: true }
                    : null;
            },
        };
        return { host, invoked, release, started };
    }

    async function drainTurns(): Promise<void> {
        for (let tick = 0; tick < 5; tick += 1)
            // eslint-disable-next-line no-await-in-loop -- each turn must drain before the next one is scheduled
            await new Promise<void>((resolve) => setImmediate(resolve));
    }

    /**
     * Production (0.0.122) logged a 7.8s Status panel merge (`viewContainers.executeCommand` waiting on `gh pr merge`)
     * holding the Desktop lane, so a Session tab click's `session.select` queued for 6s before its 33ms handler ran.
     */
    it.each([
        ['viewContainers.executeCommand', extensionCommand],
        ['viewContainers.viewOperation', sourceAction],
    ] as const)(
        'lets a Session switch and a read pass a running %s mutation',
        async (method, parameters) => {
            const blocked = blockingHost(method);
            const { read, socket } = await connectDesktop(blocked.host);
            socket.send(command('mutation', method, parameters));
            await blocked.started.promise;
            socket.send(command('select', 'session.select', { sessionId: 'session-2' }));
            await expect(read()).resolves.toMatchObject({ reply: { id: 'select' } });
            socket.send(command('records', 'app.records', {}));
            await expect(read()).resolves.toMatchObject({ reply: { id: 'records' } });
            blocked.release.resolve();
            await expect(read()).resolves.toMatchObject({ reply: { id: 'mutation' } });
        },
    );

    /**
     * A Source Control action and an Extension command are arbitrary Extension mutations (Git sync, discard, merge)
     * with no serialization owner below the lane, so two of them from one Desktop must not overlap, and a core Git
     * write must not land in the middle of an Extension `git pull`.
     */
    it.each([
        ['viewContainers.executeCommand', extensionCommand],
        ['viewContainers.viewOperation', sourceAction],
        ['git.switchBranch', switchBranch],
    ] as const)('keeps %s behind a running Extension mutation', async (method, parameters) => {
        const blocked = blockingHost('viewContainers.executeCommand');
        const written: Array<{ correlationId?: string; fields?: Record<string, unknown> }> = [];
        const { read, socket } = await connectDesktop(blocked.host, {
            write: (_level, event, options) => {
                if (event === 'ipc.request') written.push(options ?? {});
            },
        });
        socket.send(command('first', 'viewContainers.executeCommand', extensionCommand));
        await blocked.started.promise;
        socket.send(command('second', method, parameters));
        await drainTurns();
        expect(blocked.invoked).toEqual(['viewContainers.executeCommand']);
        blocked.release.resolve();
        await expect(read()).resolves.toMatchObject({ reply: { id: 'first' } });
        await expect(read()).resolves.toMatchObject({ reply: { id: 'second' } });
        expect(blocked.invoked).toEqual(['viewContainers.executeCommand', method]);
        // The wait is attributed to the repository lane, not to an ordinary ordered write.
        expect(written.find((entry) => entry.correlationId === 'second')?.fields).toMatchObject({
            method,
            lane: 'repository',
        });
    });

    it('starts an Extension mutation only after an earlier ordered write settles', async () => {
        const blocked = blockingHost('session.select');
        const { read, socket } = await connectDesktop(blocked.host);
        socket.send(command('select', 'session.select', { sessionId: 'session-2' }));
        await blocked.started.promise;
        socket.send(command('merge', 'viewContainers.executeCommand', extensionCommand));
        await drainTurns();
        expect(blocked.invoked).toEqual(['session.select']);
        blocked.release.resolve();
        await expect(read()).resolves.toMatchObject({ reply: { id: 'select' } });
        await expect(read()).resolves.toMatchObject({ reply: { id: 'merge' } });
    });
});

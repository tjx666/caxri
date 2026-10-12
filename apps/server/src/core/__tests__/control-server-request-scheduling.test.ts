import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import { protocolFeatures } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

/**
 * Split out of `control-server.test.ts` to keep it under the repository's source-size budget. This file owns request
 * scheduling over the authenticated transport: a slow request must not starve later lanes, and a long write must stay
 * pending until its authoritative result arrives. The `profile` fixture intentionally mirrors the sibling files rather
 * than being shared, matching `control-server-view-lane.test.ts`.
 */
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

describe('local Host transport request scheduling', () => {
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

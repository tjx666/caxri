import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import { protocolFeatures } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

async function captureOutcome<Value>(
    promise: Promise<Value>,
): Promise<{ error?: unknown; value?: Value }> {
    try {
        return { value: await promise };
    } catch (error) {
        return { error };
    }
}

function terminalSnapshot(terminalId: string) {
    return {
        terminalId,
        encodingVersion: 3 as const,
        cols: 80,
        rows: 24,
        lineCount: 0,
        byteCount: 0,
        payload: '',
        updatedAt: 1,
    };
}

describe('Binary Terminal stream lifecycle', () => {
    it('keeps reattachment ordered after the client times out an earlier detach', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-detach-timeout-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const detachResult = Promise.withResolvers<unknown>();
        const requests: string[] = [];
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: (request) => {
                        requests.push(request.method);
                        if (request.method === 'terminal.attach')
                            return terminalSnapshot(request.params.terminalId);
                        if (request.method === 'terminal.detach') return detachResult.promise;
                        throw new Error(`Unexpected method: ${request.method}`);
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: '7'.repeat(32),
                stateEpoch: '8'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 150, {
                kind: 'desktop',
                desktopId: 'desktop-binary-detach-timeout',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();
            await client.request('terminal.attach', { terminalId: 'terminal-1' });

            const detaching = captureOutcome(
                client.request('terminal.detach', { terminalId: 'terminal-1' }),
            );
            await vi.waitFor(() =>
                expect(requests).toEqual(['terminal.attach', 'terminal.detach']),
            );
            await expect(detaching).resolves.toMatchObject({ error: { code: 'TIMEOUT' } });

            const reattaching = captureOutcome(
                client.request('terminal.attach', { terminalId: 'terminal-1' }),
            );
            const settledBeforeServerDetach = await Promise.race([
                (async () => {
                    await reattaching;
                    return true;
                })(),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
            ]);
            expect(settledBeforeServerDetach).toBe(false);
            expect(requests).toEqual(['terminal.attach', 'terminal.detach']);

            detachResult.resolve(null);
            await expect(reattaching).resolves.toMatchObject({
                value: { terminalId: 'terminal-1' },
            });
            expect(requests).toEqual(['terminal.attach', 'terminal.detach', 'terminal.attach']);
        } finally {
            detachResult.resolve(null);
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });

    it('settles an admitted old attachment before detach and a replacement attachment', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-old-attach-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const firstAttachment = Promise.withResolvers<ReturnType<typeof terminalSnapshot>>();
        const requests: string[] = [];
        let attachmentCount = 0;
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: (request) => {
                        requests.push(request.method);
                        if (request.method === 'terminal.attach') {
                            attachmentCount += 1;
                            return attachmentCount === 1
                                ? firstAttachment.promise
                                : terminalSnapshot(request.params.terminalId);
                        }
                        if (request.method === 'terminal.detach') return null;
                        throw new Error(`Unexpected method: ${request.method}`);
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: '9'.repeat(32),
                stateEpoch: 'a'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-old-attach',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            const attaching = captureOutcome(
                client.request('terminal.attach', { terminalId: 'terminal-1' }),
            );
            await vi.waitFor(() => expect(requests).toEqual(['terminal.attach']));
            const detaching = captureOutcome(
                client.request('terminal.detach', { terminalId: 'terminal-1' }),
            );
            const reattaching = captureOutcome(
                client.request('terminal.attach', { terminalId: 'terminal-1' }),
            );
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(requests).toEqual(['terminal.attach']);

            firstAttachment.resolve(terminalSnapshot('terminal-1'));
            await expect(attaching).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
            await expect(detaching).resolves.toEqual({ value: null });
            await expect(reattaching).resolves.toMatchObject({
                value: { terminalId: 'terminal-1' },
            });
            expect(requests).toEqual(['terminal.attach', 'terminal.detach', 'terminal.attach']);
        } finally {
            firstAttachment.resolve(terminalSnapshot('terminal-1'));
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });
});

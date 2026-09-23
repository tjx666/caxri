import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import { CaxriError, protocolFeatures } from '@caxri/protocol';
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

function terminalSnapshot(terminalId: string, payload = '') {
    return {
        terminalId,
        encodingVersion: 3 as const,
        cols: 80,
        rows: 24,
        lineCount: 0,
        byteCount: new TextEncoder().encode(payload).byteLength,
        payload,
        updatedAt: 1,
    };
}

describe('Binary Terminal stream lifecycle', () => {
    it.each(['TIMEOUT', 'UNAVAILABLE', 'late-reply'] as const)(
        'reopens the output channel after an attachment failure: %s',
        async (failure) => {
            const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-attach-recovery-'));
            const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
            const firstAttachment = Promise.withResolvers<ReturnType<typeof terminalSnapshot>>();
            let attachmentCount = 0;
            const server = new ControlServer({
                adapters: {
                    features: protocolFeatures,
                    server: {
                        invoke: (request) => {
                            if (request.method !== 'terminal.attach')
                                throw new Error(`Unexpected method: ${request.method}`);
                            attachmentCount += 1;
                            if (attachmentCount === 1) {
                                if (failure === 'late-reply') return firstAttachment.promise;
                                throw new CaxriError(failure, 'Synthetic attachment failure');
                            }
                            return terminalSnapshot(request.params.terminalId, 'recovered-screen');
                        },
                    },
                },
                desktopCredential: lease.desktopCredential,
                identity: lease.identity,
                protocolIdentity: { serverId: 'b'.repeat(32), stateEpoch: 'c'.repeat(32) },
            });
            let client: ServerClient | undefined;
            let releaseTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await lease.publish(await server.start());
                client = await ServerClient.connect(lease.manifest, 150, {
                    kind: 'desktop',
                    desktopId: 'desktop-binary-attach-recovery',
                    credential: lease.desktopCredential,
                    handleCommand: () => Promise.resolve(null),
                });
                await client.markDesktopReady();
                const output: string[] = [];
                client.onEvent((event) => {
                    if (event.event === 'terminal.output') output.push(event.payload.data);
                });
                const attaching = captureOutcome(
                    client.request('terminal.attach', { terminalId: 'terminal-1' }),
                );
                await vi.waitFor(() => expect(attachmentCount).toBe(1));
                if (failure === 'late-reply')
                    releaseTimer = setTimeout(() => {
                        firstAttachment.resolve(terminalSnapshot('terminal-1', 'stale-screen'));
                    }, 200);
                await expect(attaching).resolves.toMatchObject({
                    value: { terminalId: 'terminal-1', payload: 'recovered-screen' },
                });
                expect(attachmentCount).toBe(2);
                server.broadcast({
                    event: 'terminal.output',
                    payload: { terminalId: 'terminal-1', data: 'recovered-output' },
                });
                await vi.waitFor(() => expect(output).toEqual(['recovered-output']));
            } finally {
                if (releaseTimer) clearTimeout(releaseTimer);
                firstAttachment.resolve(terminalSnapshot('terminal-1'));
                client?.close();
                await server.close();
                await lease.release();
                await rm(userDataPath, { recursive: true, force: true });
            }
        },
    );

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

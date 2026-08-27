import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { ServerClient } from '@caxri/client/supervise';
import type {
    BinaryStreamOperation,
    BinaryStreamTicketGrant,
    CommandAdapter,
} from '@caxri/protocol';
import { protocolFeatures } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { RawData } from 'ws';

import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

interface CapturedControlMessage {
    operation?: { method: string };
    request?: { method: string };
    type?: string;
}

function controlSource(data: RawData): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return Buffer.concat(data).toString('utf8');
}

async function captureOutcome<Value>(
    promise: Promise<Value>,
): Promise<{ error?: unknown; value?: Value }> {
    try {
        return { value: await promise };
    } catch (error) {
        return { error };
    }
}

describe('architecture-a5-binary-streams: ServerClient integration', () => {
    it('cancels an in-flight attachment when the Terminal detaches', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-detach-overlap-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const requests: string[] = [];
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: (request) => {
                        requests.push(request.method);
                        if (request.method === 'terminal.attach')
                            return {
                                terminalId: request.params.terminalId,
                                encodingVersion: 3,
                                cols: 80,
                                rows: 24,
                                lineCount: 0,
                                byteCount: 0,
                                payload: '',
                                updatedAt: 1,
                            };
                        if (
                            request.method === 'terminal.detach' ||
                            request.method === 'terminal.input'
                        )
                            return null;
                        throw new Error(`Unexpected method: ${request.method}`);
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: '3'.repeat(32),
                stateEpoch: '4'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-detach-overlap',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            const binaryStreams = Reflect.get(client, 'binaryStreams') as object;
            const options = Reflect.get(binaryStreams, 'options') as {
                issueTicket: (
                    id: string,
                    operation: BinaryStreamOperation,
                ) => Promise<BinaryStreamTicketGrant>;
            };
            const issueTicket = options.issueTicket;
            const attachAuthorization = Promise.withResolvers<void>();
            const authorizations: string[] = [];
            options.issueTicket = async (id, operation) => {
                authorizations.push(operation.method);
                if (operation.method === 'terminal.attach') await attachAuthorization.promise;
                return issueTicket(id, operation);
            };

            const attaching = captureOutcome(
                client.request('terminal.attach', { terminalId: 'terminal-1' }),
            );
            await vi.waitFor(() => expect(authorizations).toEqual(['terminal.attach']));
            await expect(
                client.request('terminal.detach', { terminalId: 'terminal-1' }),
            ).resolves.toBeNull();
            attachAuthorization.resolve();
            await expect(attaching).resolves.toMatchObject({ error: { code: 'CANCELLED' } });
            await expect(
                client.request('terminal.input', {
                    terminalId: 'terminal-1',
                    data: 'after-detach',
                }),
            ).resolves.toBeNull();
            expect(authorizations).toEqual(['terminal.attach', 'terminal.input']);
            expect(requests).toEqual(['terminal.detach', 'terminal.input']);
        } finally {
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });

    it('keeps an attachment started after an earlier detach request', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-reattach-detach-'));
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
                            return {
                                terminalId: request.params.terminalId,
                                encodingVersion: 3,
                                cols: 80,
                                rows: 24,
                                lineCount: 0,
                                byteCount: 0,
                                payload: '',
                                updatedAt: 1,
                            };
                        if (request.method === 'terminal.detach') return detachResult.promise;
                        if (request.method === 'terminal.input') return null;
                        throw new Error(`Unexpected method: ${request.method}`);
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: '5'.repeat(32),
                stateEpoch: '6'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-reattach-detach',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            const binaryStreams = Reflect.get(client, 'binaryStreams') as object;
            const options = Reflect.get(binaryStreams, 'options') as {
                issueTicket: (
                    id: string,
                    operation: BinaryStreamOperation,
                ) => Promise<BinaryStreamTicketGrant>;
            };
            const issueTicket = options.issueTicket;
            const authorizations: string[] = [];
            options.issueTicket = (id, operation) => {
                authorizations.push(operation.method);
                return issueTicket(id, operation);
            };

            await client.request('terminal.attach', { terminalId: 'terminal-1' });
            const detaching = captureOutcome(
                client.request('terminal.detach', { terminalId: 'terminal-1' }),
            );
            await vi.waitFor(() =>
                expect(requests).toEqual(['terminal.attach', 'terminal.detach']),
            );
            const reattaching = client.request('terminal.attach', { terminalId: 'terminal-1' });
            const reattachingOutcome = captureOutcome(reattaching);
            const settledBeforeDetach = await Promise.race([
                (async () => {
                    await reattachingOutcome;
                    return true;
                })(),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
            ]);
            expect(settledBeforeDetach).toBe(false);
            expect(authorizations).toEqual(['terminal.attach']);

            detachResult.resolve(null);
            await expect(detaching).resolves.toEqual({ value: null });
            await expect(reattachingOutcome).resolves.toMatchObject({
                value: { terminalId: 'terminal-1' },
            });
            await expect(
                client.request('terminal.input', {
                    terminalId: 'terminal-1',
                    data: 'after-reattach',
                }),
            ).resolves.toBeNull();
            expect(authorizations).toEqual(['terminal.attach', 'terminal.attach']);
            expect(requests).toEqual([
                'terminal.attach',
                'terminal.detach',
                'terminal.attach',
                'terminal.input',
            ]);
        } finally {
            detachResult.resolve(null);
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });

    it('holds input behind an in-flight attachment without blocking another Terminal', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-input-order-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const requests: Array<{ method: string; terminalId: string }> = [];
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: (request) => {
                        switch (request.method) {
                            case 'terminal.attach':
                                requests.push({
                                    method: request.method,
                                    terminalId: request.params.terminalId,
                                });
                                return {
                                    terminalId: request.params.terminalId,
                                    encodingVersion: 3,
                                    cols: 80,
                                    rows: 24,
                                    lineCount: 0,
                                    byteCount: 0,
                                    payload: '',
                                    updatedAt: 1,
                                };
                            case 'terminal.input':
                            case 'terminal.resize':
                                requests.push({
                                    method: request.method,
                                    terminalId: request.params.terminalId,
                                });
                                return null;
                            default:
                                throw new Error(`Unexpected method: ${request.method}`);
                        }
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'c'.repeat(32),
                stateEpoch: 'd'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-input-order',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            const binaryStreams = Reflect.get(client, 'binaryStreams') as object;
            const options = Reflect.get(binaryStreams, 'options') as {
                issueTicket: (
                    id: string,
                    operation: BinaryStreamOperation,
                ) => Promise<BinaryStreamTicketGrant>;
            };
            const issueTicket = options.issueTicket;
            const attachAuthorization = Promise.withResolvers<void>();
            const authorizations: Array<{ method: string; terminalId: string }> = [];
            options.issueTicket = async (id, operation) => {
                if ('terminalId' in operation)
                    authorizations.push({
                        method: operation.method,
                        terminalId: operation.terminalId,
                    });
                if (operation.method === 'terminal.attach') await attachAuthorization.promise;
                return issueTicket(id, operation);
            };

            const attaching = client.request('terminal.attach', {
                terminalId: 'terminal-1',
            });
            await vi.waitFor(() => expect(authorizations).toHaveLength(1));
            const input = client.request('terminal.input', {
                terminalId: 'terminal-1',
                data: 'ordered',
            });
            const resize = client.request('terminal.resize', {
                terminalId: 'terminal-1',
                cols: 120,
                rows: 40,
            });
            const independent = client.request('terminal.input', {
                terminalId: 'terminal-2',
                data: 'independent',
            });
            await expect(independent).resolves.toBeNull();
            expect(authorizations.filter(({ terminalId }) => terminalId === 'terminal-1')).toEqual([
                { method: 'terminal.attach', terminalId: 'terminal-1' },
            ]);
            expect(requests).toEqual([{ method: 'terminal.input', terminalId: 'terminal-2' }]);
            attachAuthorization.resolve();
            await expect(Promise.all([attaching, input, resize])).resolves.toEqual([
                expect.objectContaining({ terminalId: 'terminal-1' }),
                null,
                null,
            ]);
            expect(requests).toEqual([
                { method: 'terminal.input', terminalId: 'terminal-2' },
                { method: 'terminal.attach', terminalId: 'terminal-1' },
                { method: 'terminal.input', terminalId: 'terminal-1' },
                { method: 'terminal.resize', terminalId: 'terminal-1' },
            ]);
        } finally {
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });

    it('drains pending input before replacing a persistent Terminal attachment', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-reattach-order-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const slowInput = Promise.withResolvers<unknown>();
        const requests: string[] = [];
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: (request) => {
                        if (request.method === 'terminal.attach') {
                            requests.push('attach');
                            return {
                                terminalId: request.params.terminalId,
                                encodingVersion: 3,
                                cols: 80,
                                rows: 24,
                                lineCount: 0,
                                byteCount: 0,
                                payload: '',
                                updatedAt: 1,
                            };
                        }
                        if (request.method === 'terminal.input') {
                            requests.push(`input:${request.params.data}`);
                            return slowInput.promise;
                        }
                        throw new Error(`Unexpected method: ${request.method}`);
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'e'.repeat(32),
                stateEpoch: 'f'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-reattach-order',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            const binaryStreams = Reflect.get(client, 'binaryStreams') as object;
            const options = Reflect.get(binaryStreams, 'options') as {
                issueTicket: (
                    id: string,
                    operation: BinaryStreamOperation,
                ) => Promise<BinaryStreamTicketGrant>;
            };
            const issueTicket = options.issueTicket;
            let attachAuthorizationCount = 0;
            options.issueTicket = (id, operation) => {
                if (operation.method === 'terminal.attach') attachAuthorizationCount += 1;
                return issueTicket(id, operation);
            };

            await client.request('terminal.attach', { terminalId: 'terminal-1' });
            const input = client.request('terminal.input', {
                terminalId: 'terminal-1',
                data: 'slow',
            });
            await vi.waitFor(() => expect(requests).toContain('input:slow'));
            const reattaching = client.request('terminal.attach', {
                terminalId: 'terminal-1',
            });

            expect(attachAuthorizationCount).toBe(1);
            slowInput.resolve(null);
            await expect(input).resolves.toBeNull();
            await expect(reattaching).resolves.toMatchObject({ terminalId: 'terminal-1' });
            expect(attachAuthorizationCount).toBe(2);
            expect(requests).toEqual(['attach', 'input:slow', 'attach']);
        } finally {
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });

    it('falls back to ordered one-shot input after attachment authorization fails', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-attach-fallback-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const input: string[] = [];
        const server = new ControlServer({
            adapters: {
                features: protocolFeatures,
                server: {
                    invoke: (request) => {
                        if (request.method !== 'terminal.input')
                            throw new Error(`Unexpected method: ${request.method}`);
                        input.push(request.params.data);
                        return null;
                    },
                },
            },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: '1'.repeat(32),
                stateEpoch: '2'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-attach-fallback',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            const binaryStreams = Reflect.get(client, 'binaryStreams') as object;
            const options = Reflect.get(binaryStreams, 'options') as {
                issueTicket: (
                    id: string,
                    operation: BinaryStreamOperation,
                ) => Promise<BinaryStreamTicketGrant>;
            };
            const issueTicket = options.issueTicket;
            const rejectAttach = Promise.withResolvers<void>();
            const authorizations: string[] = [];
            options.issueTicket = async (id, operation) => {
                authorizations.push(operation.method);
                if (operation.method === 'terminal.attach') {
                    await rejectAttach.promise;
                    throw new Error('seeded attachment authorization failure');
                }
                return issueTicket(id, operation);
            };

            const attaching = client.request('terminal.attach', {
                terminalId: 'terminal-1',
            });
            await vi.waitFor(() => expect(authorizations).toEqual(['terminal.attach']));
            const fallback = client.request('terminal.input', {
                terminalId: 'terminal-1',
                data: 'fallback',
            });
            expect(authorizations).toEqual(['terminal.attach']);

            rejectAttach.resolve();
            await expect(attaching).rejects.toThrow('seeded attachment authorization failure');
            await expect(fallback).resolves.toBeNull();
            expect(authorizations).toEqual(['terminal.attach', 'terminal.input']);
            expect(input).toEqual(['fallback']);
        } finally {
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    });

    it('preserves the canonical API and control latency without carrying bulk bodies on control', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-client-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const download = `download-private-sentinel-${'d'.repeat(8 * 1024 * 1024)}`;
        const upload = 'upload-private-sentinel';
        const snapshotPayload = 'snapshot-private-sentinel';
        const outputPayload = 'output-private-sentinel';
        const pendingRead = Promise.withResolvers<unknown>();
        const requests: Array<{ method: string; params: unknown }> = [];
        const adapter: CommandAdapter = {
            invoke: (request) => {
                requests.push(request);
                switch (request.method) {
                    case 'files.read':
                        if (request.params.path === '/project/pending.txt')
                            return pendingRead.promise;
                        return {
                            path: request.params.path,
                            content: download,
                            mtimeMs: 10,
                            size: download.length,
                        };
                    case 'files.write':
                        return {
                            path: request.params.path,
                            content: request.params.content,
                            mtimeMs: 20,
                            size: Buffer.byteLength(request.params.content, 'utf8'),
                        };
                    case 'app.health':
                        return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
                    case 'terminal.attach':
                        return {
                            terminalId: request.params.terminalId,
                            encodingVersion: 3,
                            cols: 80,
                            rows: 24,
                            lineCount: 1,
                            byteCount: Buffer.byteLength(snapshotPayload, 'utf8'),
                            payload: snapshotPayload,
                            updatedAt: 30,
                        };
                    case 'terminal.detach':
                    case 'terminal.input':
                    case 'terminal.resize':
                        return null;
                    default:
                        throw new Error(`Unexpected method: ${request.method}`);
                }
            },
        };
        const server = new ControlServer({
            adapters: { features: protocolFeatures, server: adapter },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
            },
        });
        let client: ServerClient | undefined;
        try {
            await lease.publish(await server.start());
            client = await ServerClient.connect(lease.manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-binary-client',
                credential: lease.desktopCredential,
                handleCommand: () => Promise.resolve(null),
            });
            await client.markDesktopReady();

            /**
             * The public client intentionally hides its socket; this test seam inspects control only.
             */
            const controlSocket = Reflect.get(client, 'socket') as WebSocket;
            const sent = vi.spyOn(controlSocket, 'send');
            const received: string[] = [];
            controlSocket.on('message', (data, isBinary) => {
                if (!isBinary) received.push(controlSource(data));
            });

            const transferStartedAt = performance.now();
            const transfer = client.request('files.read', {
                sessionId: 'session-1',
                path: '/project/read.txt',
            });
            const controlStartedAt = performance.now();
            await expect(client.request('app.health', {})).resolves.toMatchObject({ ready: true });
            const controlRoundTripMs = performance.now() - controlStartedAt;
            await expect(transfer).resolves.toMatchObject({ content: download });
            const transferMs = performance.now() - transferStartedAt;
            expect(controlRoundTripMs).toBeLessThan(500);
            expect(transferMs).toBeLessThan(5_000);
            process.stdout.write(
                `CAXRI_BINARY_STREAM_BENCHMARK ${JSON.stringify({
                    checkId: 'architecture-a5-binary-streams',
                    transferBytes: Buffer.byteLength(download, 'utf8'),
                    transferMs: Math.round(transferMs * 100) / 100,
                    controlRoundTripMs: Math.round(controlRoundTripMs * 100) / 100,
                })}\n`,
            );
            await expect(
                client.request('files.write', {
                    sessionId: 'session-1',
                    path: '/project/write.txt',
                    content: upload,
                }),
            ).resolves.toMatchObject({ content: upload });
            await expect(
                client.request('terminal.attach', {
                    terminalId: 'terminal-1',
                    cols: 80,
                    rows: 24,
                }),
            ).resolves.toMatchObject({ payload: snapshotPayload });
            await expect(
                client.request('terminal.input', {
                    terminalId: 'terminal-1',
                    data: 'ls\r',
                }),
            ).resolves.toBeNull();
            await expect(
                client.request('terminal.resize', {
                    terminalId: 'terminal-1',
                    cols: 120,
                    rows: 40,
                }),
            ).resolves.toBeNull();

            const output = Promise.withResolvers<unknown>();
            const unsubscribe = client.onEvent((event) => {
                if (event.event === 'terminal.output') output.resolve(event);
            });
            server.broadcast({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: outputPayload },
            });
            await expect(output.promise).resolves.toEqual({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: outputPayload },
            });
            unsubscribe();
            await expect(
                client.request('terminal.detach', { terminalId: 'terminal-1' }),
            ).resolves.toBeNull();

            const sentControl = sent.mock.calls.flatMap(([data]) =>
                typeof data === 'string' ? [data] : [],
            );
            const messages = sentControl.map(
                (source) => JSON.parse(source) as CapturedControlMessage,
            );
            expect(
                messages
                    .filter((message) => message.type === 'stream-ticket.request')
                    .map((message) => message.operation?.method),
            ).toEqual(['files.read', 'files.write', 'terminal.attach']);
            expect(
                messages
                    .filter((message) => message.type === 'command')
                    .map((message) => message.request?.method),
            ).toEqual(['app.health', 'terminal.detach']);
            expect([...sentControl, ...received].join('\n')).not.toMatch(
                /(?:download|upload|snapshot|output)-private-sentinel/u,
            );
            expect(requests).toHaveLength(7);
            expect(requests).toEqual(
                expect.arrayContaining([
                    {
                        method: 'files.read',
                        params: { sessionId: 'session-1', path: '/project/read.txt' },
                    },
                    { method: 'app.health', params: {} },
                    {
                        method: 'files.write',
                        params: {
                            sessionId: 'session-1',
                            path: '/project/write.txt',
                            content: upload,
                        },
                    },
                    {
                        method: 'terminal.attach',
                        params: { terminalId: 'terminal-1', cols: 80, rows: 24 },
                    },
                    {
                        method: 'terminal.input',
                        params: { terminalId: 'terminal-1', data: 'ls\r' },
                    },
                    {
                        method: 'terminal.resize',
                        params: { terminalId: 'terminal-1', cols: 120, rows: 40 },
                    },
                    {
                        method: 'terminal.detach',
                        params: { terminalId: 'terminal-1' },
                    },
                ]),
            );

            const pending = client.request('files.read', {
                sessionId: 'session-1',
                path: '/project/pending.txt',
            });
            await vi.waitFor(() =>
                expect(requests).toContainEqual({
                    method: 'files.read',
                    params: { sessionId: 'session-1', path: '/project/pending.txt' },
                }),
            );
            client.close({ cancelPendingRequests: true });
            await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
            pendingRead.resolve({
                path: '/project/pending.txt',
                content: '',
                mtimeMs: 40,
                size: 0,
            });
        } finally {
            client?.close();
            await server.close();
            await lease.release();
            await rm(userDataPath, { recursive: true, force: true });
        }
    }, 10_000);
});

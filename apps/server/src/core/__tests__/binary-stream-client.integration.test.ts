import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import type { CommandAdapter } from '@caxri/protocol';
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

describe('ServerClient binary stream integration', () => {
    it('preserves the canonical API without carrying Terminal or file bodies on control', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-binary-client-'));
        const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
        const download = 'download-private-sentinel';
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

            await expect(
                client.request('files.read', {
                    sessionId: 'session-1',
                    path: '/project/read.txt',
                }),
            ).resolves.toMatchObject({ content: download });
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
            ).toEqual(['terminal.detach']);
            expect([...sentControl, ...received].join('\n')).not.toMatch(
                /(?:download|upload|snapshot|output)-private-sentinel/u,
            );
            expect(requests).toEqual([
                {
                    method: 'files.read',
                    params: { sessionId: 'session-1', path: '/project/read.txt' },
                },
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
            ]);

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
    });
});

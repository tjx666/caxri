import { Buffer } from 'node:buffer';

import type {
    BinaryStreamFrame,
    BinaryStreamReply,
    CommandAdapter,
    CommandExecutionContext,
} from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_CHUNK_BYTES,
    binaryStreamReplySchema,
    createCommandDispatcher,
    decodeBinaryStreamFrame,
    encodeBinaryStreamFrame,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import type { BinaryStreamClaim as ServerBinaryStreamClaim } from '../binary-stream-control';
import { BinaryStreamRuntime } from '../binary-stream-runtime';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    const pending = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(pending.map((cleanup) => cleanup()));
});

const context: CommandExecutionContext = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
    connection: {
        serverId: 'a'.repeat(32),
        bootId: 'b'.repeat(32),
        stateEpoch: 'c'.repeat(32),
        clientId: 'desktop-1',
        connectionId: 'd'.repeat(32),
    },
};

class FrameReader {
    private readonly frames: BinaryStreamFrame[] = [];
    private readonly waiters: Array<(frame: BinaryStreamFrame) => void> = [];

    constructor(socket: WebSocket) {
        socket.on('message', (data, isBinary) => {
            if (!isBinary || !Buffer.isBuffer(data))
                throw new TypeError('Expected a buffered binary stream frame');
            const frame = decodeBinaryStreamFrame(data);
            const waiter = this.waiters.shift();
            if (waiter) waiter(frame);
            else this.frames.push(frame);
        });
    }

    next(): Promise<BinaryStreamFrame> {
        const frame = this.frames.shift();
        return frame
            ? Promise.resolve(frame)
            : new Promise((resolve) => {
                  this.waiters.push(resolve);
              });
    }

    async group(kind: BinaryStreamFrame['kind'], sequence = 0): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        while (true) {
            // eslint-disable-next-line no-await-in-loop -- a logical payload is intentionally reconstructed frame by frame
            const frame = await this.next();
            expect(frame.kind).toBe(kind);
            expect(frame.sequence).toBe(sequence);
            chunks.push(frame.payload);
            byteLength += frame.payload.byteLength;
            if (frame.final) break;
        }
        const combined = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return combined;
    }
}

function closeEvent(socket: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
        socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
}

async function connectRuntime(
    claim: ServerBinaryStreamClaim,
    adapter: CommandAdapter,
    logger?: { recordMetric: StructuredLogger['recordMetric'] },
): Promise<{ client: WebSocket; reader: FrameReader; runtime: BinaryStreamRuntime }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Expected a TCP WebSocket listener');
    const runtime = new BinaryStreamRuntime({
        dispatch: createCommandDispatcher({ server: adapter }),
        isDesktopConnectionCurrent: () => true,
        logger,
    });
    server.once('connection', (socket) => runtime.accept(socket, claim));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const reader = new FrameReader(client);
    await new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
    });
    cleanups.push(async () => {
        runtime.close();
        client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { client, reader, runtime };
}

function claim(operation: ServerBinaryStreamClaim['operation']): ServerBinaryStreamClaim {
    return {
        connectionId: context.connection!.connectionId,
        context,
        operation,
        requestId: 'request-1',
    };
}

function reply(bytes: Uint8Array): BinaryStreamReply {
    return binaryStreamReplySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

describe('BinaryStreamRuntime file transfer', () => {
    it('downloads file content only through bounded binary data frames', async () => {
        const content = `private-sentinel-${'界'.repeat(BINARY_STREAM_MAX_CHUNK_BYTES)}`;
        const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
        const adapter: CommandAdapter = {
            invoke: () => ({ path: '/project/file.txt', content, mtimeMs: 12, size: 34 }),
        };
        const { client, reader } = await connectRuntime(
            claim({ method: 'files.read', sessionId: 'session-1', path: '/project/file.txt' }),
            adapter,
            { recordMetric },
        );
        const closed = closeEvent(client);

        expect(reply(await reader.group('file-reply'))).toEqual({
            id: 'request-1',
            method: 'files.read',
            ok: true,
            result: {
                kind: 'file-document',
                path: '/project/file.txt',
                mtimeMs: 12,
                size: 34,
                contentBytes: new TextEncoder().encode(content).byteLength,
            },
        });
        expect(new TextDecoder().decode(await reader.group('file-data'))).toBe(content);
        expect(await closed).toEqual({ code: 4000, reason: 'completed' });
        expect(recordMetric).toHaveBeenCalledWith('connection.buffered_bytes', expect.any(Number), {
            owner: 'stream',
            phase: 'transfer',
            outcome: 'success',
        });
        expect(recordMetric).toHaveBeenCalledWith('connection.closed', 1, {
            owner: 'stream',
            phase: 'shutdown',
            outcome: 'success',
        });
        expect(JSON.stringify(recordMetric.mock.calls)).not.toContain('private-sentinel');
    });

    it('uploads exact UTF-8 bytes and returns the canonical saved document', async () => {
        const content = 'edited 界';
        const requests: Array<{ method: string; params: unknown }> = [];
        const adapter: CommandAdapter = {
            invoke: (request) => {
                requests.push(request);
                return { path: '/project/file.txt', content, mtimeMs: 20, size: 10 };
            },
        };
        const payload = new TextEncoder().encode(content);
        const { client, reader } = await connectRuntime(
            claim({
                method: 'files.write',
                sessionId: 'session-1',
                path: '/project/file.txt',
                byteLength: payload.byteLength,
            }),
            adapter,
        );
        const closed = closeEvent(client);
        client.send(
            encodeBinaryStreamFrame({
                final: true,
                kind: 'file-data',
                payload,
                sequence: 0,
            }),
        );

        expect(reply(await reader.group('file-reply')).ok).toBe(true);
        expect(new TextDecoder().decode(await reader.group('file-data'))).toBe(content);
        expect(await closed).toEqual({ code: 4000, reason: 'completed' });
        expect(requests).toEqual([
            {
                method: 'files.write',
                params: { sessionId: 'session-1', path: '/project/file.txt', content },
            },
        ]);
    });

    it('fails closed on a cross-lane frame before invoking the file adapter', async () => {
        const requests: unknown[] = [];
        const { client } = await connectRuntime(
            claim({ method: 'files.write', sessionId: 'session-1', path: 'a.txt', byteLength: 1 }),
            { invoke: (request) => requests.push(request) },
        );
        const closed = closeEvent(client);
        client.send(
            encodeBinaryStreamFrame({
                final: true,
                kind: 'terminal-input',
                payload: new Uint8Array([1]),
                sequence: 0,
            }),
        );

        expect(await closed).toEqual({ code: 4403, reason: 'scope-mismatch' });
        expect(requests).toEqual([]);
    });

    it('uses a typed close reason for an oversized declared chunk', async () => {
        const { client } = await connectRuntime(
            claim({ method: 'files.write', sessionId: 'session-1', path: 'a.txt', byteLength: 1 }),
            { invoke: () => null },
        );
        const closed = closeEvent(client);
        const malformed = encodeBinaryStreamFrame({
            final: true,
            kind: 'file-data',
            payload: new Uint8Array(),
            sequence: 0,
        });
        new DataView(malformed.buffer).setUint32(12, BINARY_STREAM_MAX_CHUNK_BYTES + 1);
        client.send(malformed);

        expect(await closed).toEqual({ code: 4413, reason: 'payload-too-large' });
    });
});

describe('BinaryStreamRuntime Terminal attachment', () => {
    it('preserves snapshot, output, input, resize, and output-gap behavior', async () => {
        const requests: Array<{ method: string; params: unknown }> = [];
        const snapshot = {
            terminalId: 'terminal-1',
            encodingVersion: 3,
            cols: 80,
            rows: 24,
            lineCount: 1,
            byteCount: 4,
            payload: 'base',
            updatedAt: 1,
        };
        const adapter: CommandAdapter = {
            invoke: (request) => {
                requests.push(request);
                return request.method === 'terminal.attach' ? snapshot : null;
            },
        };
        const { client, reader, runtime } = await connectRuntime(
            claim({ method: 'terminal.attach', terminalId: 'terminal-1', cols: 80, rows: 24 }),
            adapter,
        );
        const closed = closeEvent(client);

        expect(reply(await reader.group('terminal-reply'))).toMatchObject({
            method: 'terminal.attach',
            ok: true,
            result: {
                kind: 'terminal-attachment',
                snapshot: {
                    terminalId: 'terminal-1',
                    cols: 80,
                    rows: 24,
                    payloadBytes: 4,
                },
            },
        });
        const snapshotBytes = await reader.group('terminal-snapshot');
        expect(new TextDecoder().decode(snapshotBytes)).toBe(snapshot.payload);
        expect(
            runtime.deliver({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'live' },
            }),
        ).toBe(true);
        expect(new TextDecoder().decode(await reader.group('terminal-output', 1))).toBe('live');

        client.send(
            encodeBinaryStreamFrame({
                final: true,
                kind: 'terminal-input',
                payload: new TextEncoder().encode('ls\r'),
                sequence: 1,
            }),
        );
        expect(reply(await reader.group('terminal-reply', 1))).toMatchObject({
            method: 'terminal.input',
            ok: true,
        });
        const size = new Uint8Array(4);
        const sizeView = new DataView(size.buffer);
        sizeView.setUint16(0, 100);
        sizeView.setUint16(2, 30);
        client.send(
            encodeBinaryStreamFrame({
                final: true,
                kind: 'terminal-resize',
                payload: size,
                sequence: 2,
            }),
        );
        expect(reply(await reader.group('terminal-reply', 2))).toMatchObject({
            method: 'terminal.resize',
            ok: true,
        });

        runtime.deliver({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'x'.repeat(2 * 1024 * 1024) },
        });
        const gap = await reader.group('terminal-gap', 2);
        expect(Number(new DataView(gap.buffer).getBigUint64(0))).toBe(2 * 1024 * 1024);
        runtime.deliver({
            protocolVersion: 2,
            cursor: 1,
            event: {
                event: 'terminal.exit',
                payload: { terminalId: 'terminal-1', exitCode: 0 },
            },
        });
        expect(await closed).toEqual({ code: 4000, reason: 'completed' });
        expect(requests).toEqual([
            {
                method: 'terminal.attach',
                params: { terminalId: 'terminal-1', cols: 80, rows: 24 },
            },
            { method: 'terminal.input', params: { terminalId: 'terminal-1', data: 'ls\r' } },
            {
                method: 'terminal.resize',
                params: { terminalId: 'terminal-1', cols: 100, rows: 30 },
            },
        ]);
    });
});

import { Buffer } from 'node:buffer';

import type { BinaryStreamFrame } from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_BUFFERED_BYTES,
    BINARY_STREAM_MAX_CHUNK_BYTES,
    decodeBinaryStreamFrame,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { ClientSocketWriter } from '../binary-stream-client-support';

describe('ClientSocketWriter', () => {
    it.each([false, true])(
        'preserves resize and input order around a large paste (resize first: %s)',
        async (resizeFirst) => {
            const sent: BinaryStreamFrame[] = [];
            const writer = new ClientSocketWriter({
                bufferedAmount: 0,
                readyState: 1,
                send(source: Uint8Array, _options: unknown, callback: (error?: Error) => void) {
                    sent.push(decodeBinaryStreamFrame(source));
                    queueMicrotask(callback);
                },
            } as unknown as WebSocket);
            const requests: Array<{ kind: BinaryStreamFrame['kind']; payload: Uint8Array }> = [
                {
                    kind: 'terminal-input',
                    payload: new Uint8Array(BINARY_STREAM_MAX_BUFFERED_BYTES + 12),
                },
                { kind: 'terminal-resize', payload: new Uint8Array(4) },
            ];
            if (resizeFirst) requests.reverse();
            requests.push({ kind: 'terminal-input', payload: new Uint8Array([42]) });

            await expect(
                Promise.all(
                    requests.map(({ kind, payload }, sequence) =>
                        writer.sendChunks(kind, sequence, payload),
                    ),
                ),
            ).resolves.toEqual([undefined, undefined, undefined]);
            expect(sent.filter((frame) => frame.final).map((frame) => frame.sequence)).toEqual([
                0, 1, 2,
            ]);
            for (const [sequence, request] of requests.entries()) {
                const frames = sent.filter((frame) => frame.sequence === sequence);
                expect(frames.every((frame) => frame.kind === request.kind)).toBe(true);
                expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.payload)))).toEqual(
                    Buffer.from(request.payload),
                );
            }
        },
    );

    it.each(['terminal-input', 'file-data'] as const)(
        'bounds the large %s reservation independently of ordinary bursts',
        async (kind) => {
            const writer = new ClientSocketWriter({
                bufferedAmount: 0,
                readyState: 1,
                send(_source: Uint8Array, _options: unknown, callback: (error?: Error) => void) {
                    queueMicrotask(callback);
                },
            } as unknown as WebSocket);
            const large = new Uint8Array(BINARY_STREAM_MAX_BUFFERED_BYTES + 12);
            const pending = writer.sendChunks(kind, 1, large);
            const burst = writer.sendChunks(
                kind,
                2,
                new Uint8Array(BINARY_STREAM_MAX_BUFFERED_BYTES),
            );
            const rejected = [
                writer.sendChunks(kind, 3, large),
                writer.sendChunks(kind, 4, new Uint8Array(1)),
            ];
            await Promise.all(
                rejected.map(async (request) => {
                    await expect(request).rejects.toMatchObject({ code: 'CAPACITY' });
                }),
            );
            await expect(Promise.all([pending, burst])).resolves.toEqual([undefined, undefined]);
            await expect(writer.sendChunks(kind, 5, large)).resolves.toBeUndefined();
        },
    );

    it.each([1, BINARY_STREAM_MAX_BUFFERED_BYTES + 12])(
        'returns the reservation after a failed %s-byte send',
        async (size) => {
            let isFail = true;
            const writer = new ClientSocketWriter({
                bufferedAmount: 0,
                readyState: 1,
                send(_source: Uint8Array, _options: unknown, callback: (error?: Error) => void) {
                    callback(isFail ? new Error('controlled send failure') : undefined);
                },
            } as unknown as WebSocket);
            await expect(
                writer.sendChunks('terminal-input', 1, new Uint8Array(size)),
            ).rejects.toThrow('controlled send failure');
            isFail = false;
            await expect(
                writer.sendChunks(
                    'terminal-input',
                    2,
                    new Uint8Array(BINARY_STREAM_MAX_BUFFERED_BYTES),
                ),
            ).resolves.toBeUndefined();
            await expect(
                writer.sendChunks(
                    'terminal-input',
                    3,
                    new Uint8Array(BINARY_STREAM_MAX_BUFFERED_BYTES + 12),
                ),
            ).resolves.toBeUndefined();
        },
    );

    it('waits for each WebSocket callback before sending the next chunk', async () => {
        const callbacks: Array<(error?: Error) => void> = [];
        const sent: BinaryStreamFrame[] = [];
        const socket = {
            bufferedAmount: 0,
            readyState: 1,
            send: vi.fn(
                (
                    source: Uint8Array,
                    _options: { binary: boolean },
                    callback: (error?: Error) => void,
                ) => {
                    sent.push(decodeBinaryStreamFrame(source));
                    callbacks.push(callback);
                },
            ),
        } as unknown as WebSocket;
        const writer = new ClientSocketWriter(socket);

        const pending = writer.sendChunks(
            'file-data',
            7,
            new Uint8Array(BINARY_STREAM_MAX_CHUNK_BYTES + 1),
        );
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toMatchObject({ final: false, sequence: 7 });
        expect(sent[0]?.payload).toHaveLength(BINARY_STREAM_MAX_CHUNK_BYTES);

        callbacks.shift()?.();
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1]).toMatchObject({ final: true, sequence: 7 });
        expect(sent[1]?.payload).toHaveLength(1);

        callbacks.shift()?.();
        await expect(pending).resolves.toBeUndefined();
    });
});

import type { BinaryStreamFrame } from '@caxri/protocol';
import { BINARY_STREAM_MAX_CHUNK_BYTES, decodeBinaryStreamFrame } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { ClientSocketWriter } from '../binary-stream-client-support';

describe('ClientSocketWriter', () => {
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

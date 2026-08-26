import { describe, expect, it } from 'vitest';

import {
    BINARY_STREAM_FRAME_HEADER_BYTES,
    BINARY_STREAM_MAX_CHUNK_BYTES,
    binaryStreamAuthorization,
    binaryStreamCloseCodes,
    decodeBinaryStreamFrame,
    encodeBinaryStreamFrame,
    localClientStreamTicketRequestSchema,
    localServerStreamTicketReplySchema,
} from '../binary-stream';

describe('binary stream ticket contract', () => {
    it('keeps content and long-lived credentials out of ticket requests and grants', () => {
        const request = localClientStreamTicketRequestSchema.parse({
            type: 'stream-ticket.request',
            protocolVersion: 2,
            id: 'request-1',
            operation: {
                method: 'files.write',
                sessionId: 'session-1',
                path: '/project/file.txt',
                byteLength: 12,
            },
        });
        const reply = localServerStreamTicketReplySchema.parse({
            type: 'stream-ticket.reply',
            id: request.id,
            ok: true,
            grant: {
                ticket: 'a'.repeat(64),
                path: '/stream',
                expiresAt: Date.now() + 10_000,
            },
        });

        expect(request.operation).not.toHaveProperty('content');
        expect(reply.ok && binaryStreamAuthorization(reply.grant.ticket)).toBe(
            `Bearer ${'a'.repeat(64)}`,
        );
    });

    it('rejects incomplete Terminal dimensions and oversized declared file content', () => {
        const base = {
            type: 'stream-ticket.request',
            protocolVersion: 2,
            id: 'request-1',
        };
        expect(
            localClientStreamTicketRequestSchema.safeParse({
                ...base,
                operation: { method: 'terminal.attach', terminalId: 'terminal-1', cols: 80 },
            }).success,
        ).toBe(false);
        expect(
            localClientStreamTicketRequestSchema.safeParse({
                ...base,
                operation: {
                    method: 'files.write',
                    sessionId: 'session-1',
                    path: '/project/file.txt',
                    byteLength: 16 * 1024 * 1024 + 1,
                },
            }).success,
        ).toBe(false);
    });
});

describe('binary stream framing', () => {
    it('round-trips a bounded frame through the fixed-width browser-safe codec', () => {
        const payload = new TextEncoder().encode('hello 界');
        const encoded = encodeBinaryStreamFrame({
            final: true,
            kind: 'terminal-output',
            payload,
            sequence: 42,
        });

        expect(encoded.byteLength).toBe(BINARY_STREAM_FRAME_HEADER_BYTES + payload.byteLength);
        expect(decodeBinaryStreamFrame(encoded)).toEqual({
            final: true,
            kind: 'terminal-output',
            payload,
            sequence: 42,
        });
    });

    it('rejects oversized, truncated, trailing, unknown-kind, and unknown-flag frames', () => {
        expect(() =>
            encodeBinaryStreamFrame({
                final: false,
                kind: 'file-data',
                payload: new Uint8Array(BINARY_STREAM_MAX_CHUNK_BYTES + 1),
                sequence: 0,
            }),
        ).toThrow(/chunk limit/u);

        const valid = encodeBinaryStreamFrame({
            final: false,
            kind: 'file-data',
            payload: new Uint8Array([1]),
            sequence: 0,
        });
        expect(() => decodeBinaryStreamFrame(valid.slice(0, 8))).toThrow(/truncated/u);
        expect(() => decodeBinaryStreamFrame(Uint8Array.from([...valid, 0]))).toThrow(/length/u);
        const unknownKind = valid.slice();
        unknownKind[5] = 255;
        expect(() => decodeBinaryStreamFrame(unknownKind)).toThrow(/incompatible/u);
        const unknownFlag = valid.slice();
        unknownFlag[7] = 2;
        expect(() => decodeBinaryStreamFrame(unknownFlag)).toThrow(/flags/u);
    });

    it('assigns stable private WebSocket close codes', () => {
        expect(new Set(Object.values(binaryStreamCloseCodes)).size).toBe(
            Object.keys(binaryStreamCloseCodes).length,
        );
        expect(binaryStreamCloseCodes.unauthorized).toBe(4401);
        expect(binaryStreamCloseCodes['payload-too-large']).toBe(4413);
    });
});

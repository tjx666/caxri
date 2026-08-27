import { describe, expect, it } from 'vitest';

import {
    BINARY_STREAM_FRAME_HEADER_BYTES,
    BINARY_STREAM_MAX_CHUNK_BYTES,
    BINARY_STREAM_MAX_FILE_CONTENT_BYTES,
    BINARY_STREAM_MAX_FILE_UPLOAD_BYTES,
    binaryStreamAuthorization,
    binaryStreamCloseCodes,
    binaryStreamReplySchema,
    decodeBinaryStreamFrame,
    encodeBinaryStreamFrame,
    isBinaryStreamMethod,
    localClientStreamTicketRequestSchema,
    localServerStreamTicketReplySchema,
} from '../binary-stream';

describe('binary stream ticket contract', () => {
    it('keeps routing decisions on the canonical method catalog', () => {
        expect(isBinaryStreamMethod('files.read')).toBe(true);
        expect(isBinaryStreamMethod('terminal.attach')).toBe(true);
        expect(isBinaryStreamMethod('settings.get')).toBe(false);
    });

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
                    method: 'terminal.input',
                    terminalId: 'terminal-1',
                    byteLength: 0,
                },
            }).success,
        ).toBe(true);
        expect(
            localClientStreamTicketRequestSchema.safeParse({
                ...base,
                operation: {
                    method: 'files.write',
                    sessionId: 'session-1',
                    path: '/project/file.txt',
                    byteLength: BINARY_STREAM_MAX_FILE_UPLOAD_BYTES + 1,
                },
            }).success,
        ).toBe(false);
    });

    it('separates the file upload budget from worst-case UTF-8 download expansion', () => {
        expect(BINARY_STREAM_MAX_FILE_CONTENT_BYTES).toBe(3 * BINARY_STREAM_MAX_FILE_UPLOAD_BYTES);
        expect(
            binaryStreamReplySchema.safeParse({
                id: 'request-1',
                method: 'files.read',
                ok: true,
                result: {
                    kind: 'file-document',
                    path: '/project/file.txt',
                    mtimeMs: 1,
                    size: BINARY_STREAM_MAX_FILE_UPLOAD_BYTES,
                    contentBytes: BINARY_STREAM_MAX_FILE_CONTENT_BYTES,
                },
            }).success,
        ).toBe(true);
    });

    it('keeps the Terminal screen payload out of JSON reply metadata', () => {
        const parsed = binaryStreamReplySchema.parse({
            id: 'request-1',
            method: 'terminal.attach',
            ok: true,
            result: {
                kind: 'terminal-attachment',
                snapshot: {
                    terminalId: 'terminal-1',
                    encodingVersion: 3,
                    cols: 80,
                    rows: 24,
                    lineCount: 1,
                    byteCount: 4,
                    payloadBytes: 4,
                    updatedAt: 1,
                },
            },
        });

        if (!parsed.ok || parsed.result.kind !== 'terminal-attachment' || !parsed.result.snapshot)
            throw new Error('Expected Terminal attachment metadata');
        expect(parsed.result.snapshot).not.toHaveProperty('payload');
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

import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '../domain/domain.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import { terminalSnapshotSchema } from '../domain/terminal-record.js';
import { CaxriError, errorCodes } from './errors.js';
import { protocolVersionSchema } from './version.js';

export const BINARY_STREAM_PATH = '/stream' as const;
const BINARY_STREAM_PROTOCOL_VERSION = 1 as const;
export const BINARY_STREAM_FRAME_HEADER_BYTES = 16;
export const BINARY_STREAM_MAX_CHUNK_BYTES = 64 * 1024;
export const BINARY_STREAM_MAX_FRAME_BYTES =
    BINARY_STREAM_FRAME_HEADER_BYTES + BINARY_STREAM_MAX_CHUNK_BYTES;
export const BINARY_STREAM_MAX_BUFFERED_BYTES = 1024 * 1024;
export const BINARY_STREAM_MAX_FILE_UPLOAD_BYTES = MAX_CONFIGURABLE_FILE_BYTES;
/**
 * `Buffer#toString('utf8')` replaces each malformed source byte with a three-byte replacement character. The editor
 * already accepts such non-NUL text files, so download framing must preserve that worst-case expansion.
 */
export const BINARY_STREAM_MAX_FILE_CONTENT_BYTES = 3 * MAX_CONFIGURABLE_FILE_BYTES;
export const BINARY_STREAM_MAX_TERMINAL_INPUT_BYTES = 4 * MAX_TERMINAL_INPUT_PAYLOAD_LENGTH;
export const BINARY_STREAM_MAX_TERMINAL_RESULT_BYTES = 4 * 1024 * 1024;
export const BINARY_STREAM_MAX_REPLY_BYTES = 2 * 1024 * 1024;
export const BINARY_STREAM_TICKET_TTL_MS = 10_000;
export const BINARY_STREAM_MAX_PENDING_TICKETS = 128;

const binaryStreamMethods = [
    'terminal.attach',
    'terminal.input',
    'terminal.resize',
    'files.read',
    'files.write',
] as const;
export type BinaryStreamMethod = (typeof binaryStreamMethods)[number];
const binaryStreamMethodSet = new Set<string>(binaryStreamMethods);

export function isBinaryStreamMethod(method: string): method is BinaryStreamMethod {
    return binaryStreamMethodSet.has(method);
}

const BINARY_STREAM_MAGIC = 0x4358_5231;
const BINARY_STREAM_FINAL_FLAG = 1;

export const binaryStreamTicketSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const terminalSizeSchema = {
    cols: z.number().int().min(2).max(1_000),
    rows: z.number().int().min(1).max(1_000),
};

const binaryStreamOperationSchema = z.discriminatedUnion('method', [
    z
        .object({
            method: z.literal('terminal.attach'),
            terminalId: identifierSchema,
            cols: terminalSizeSchema.cols.optional(),
            rows: terminalSizeSchema.rows.optional(),
        })
        .strict()
        .refine((value) => (value.cols === undefined) === (value.rows === undefined), {
            message: 'Terminal attachment dimensions must be provided together',
        }),
    z
        .object({
            method: z.literal('terminal.input'),
            terminalId: identifierSchema,
            byteLength: z.number().int().nonnegative().max(BINARY_STREAM_MAX_TERMINAL_INPUT_BYTES),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.resize'),
            terminalId: identifierSchema,
            ...terminalSizeSchema,
        })
        .strict(),
    z
        .object({
            method: z.literal('files.read'),
            sessionId: identifierSchema,
            path: pathSchema,
        })
        .strict(),
    z
        .object({
            method: z.literal('files.write'),
            sessionId: identifierSchema,
            path: pathSchema,
            byteLength: z.number().int().nonnegative().max(BINARY_STREAM_MAX_FILE_UPLOAD_BYTES),
        })
        .strict(),
]);

export type BinaryStreamOperation = z.infer<typeof binaryStreamOperationSchema>;

export const localClientStreamTicketRequestSchema = z
    .object({
        type: z.literal('stream-ticket.request'),
        protocolVersion: protocolVersionSchema,
        id: identifierSchema,
        operation: binaryStreamOperationSchema,
    })
    .strict();

export type LocalClientStreamTicketRequest = z.infer<typeof localClientStreamTicketRequestSchema>;

const binaryStreamTicketGrantSchema = z
    .object({
        ticket: binaryStreamTicketSchema,
        path: z.literal(BINARY_STREAM_PATH),
        expiresAt: z.number().int().positive(),
    })
    .strict();

export type BinaryStreamTicketGrant = z.infer<typeof binaryStreamTicketGrantSchema>;

const binaryStreamWireErrorSchema = z
    .object({
        code: z.enum(errorCodes),
        message: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();

export const localServerStreamTicketReplySchema = z.discriminatedUnion('ok', [
    z
        .object({
            type: z.literal('stream-ticket.reply'),
            id: identifierSchema,
            ok: z.literal(true),
            grant: binaryStreamTicketGrantSchema,
        })
        .strict(),
    z
        .object({
            type: z.literal('stream-ticket.reply'),
            id: identifierSchema,
            ok: z.literal(false),
            error: binaryStreamWireErrorSchema,
        })
        .strict(),
]);

export type LocalServerStreamTicketReply = z.infer<typeof localServerStreamTicketReplySchema>;

const binaryStreamEmptyResultSchema = z.object({ kind: z.literal('empty') }).strict();
const binaryStreamTerminalSnapshotMetadataSchema = terminalSnapshotSchema
    .omit({ payload: true })
    .extend({
        payloadBytes: z.number().int().nonnegative().max(BINARY_STREAM_MAX_TERMINAL_RESULT_BYTES),
    })
    .strict();

export type BinaryStreamTerminalSnapshotMetadata = z.infer<
    typeof binaryStreamTerminalSnapshotMetadataSchema
>;

const binaryStreamTerminalAttachmentResultSchema = z
    .object({
        kind: z.literal('terminal-attachment'),
        snapshot: binaryStreamTerminalSnapshotMetadataSchema.nullable(),
    })
    .strict();
const binaryStreamFileDocumentResultSchema = z
    .object({
        kind: z.literal('file-document'),
        readOnly: z.boolean().optional(),
        path: pathSchema,
        mtimeMs: z.number(),
        size: z.number().int().nonnegative(),
        contentBytes: z.number().int().nonnegative().max(BINARY_STREAM_MAX_FILE_CONTENT_BYTES),
    })
    .strict();

const binaryStreamReplyResultSchema = z.discriminatedUnion('kind', [
    binaryStreamEmptyResultSchema,
    binaryStreamTerminalAttachmentResultSchema,
    binaryStreamFileDocumentResultSchema,
]);

const binaryStreamReplyBaseSchema = z.object({
    id: identifierSchema,
    method: z.enum(binaryStreamMethods),
});

export const binaryStreamReplySchema = z.discriminatedUnion('ok', [
    binaryStreamReplyBaseSchema
        .extend({ ok: z.literal(true), result: binaryStreamReplyResultSchema })
        .strict(),
    binaryStreamReplyBaseSchema
        .extend({ ok: z.literal(false), error: binaryStreamWireErrorSchema })
        .strict(),
]);

export type BinaryStreamReply = z.infer<typeof binaryStreamReplySchema>;

type BinaryStreamFrameKind =
    | 'terminal-input'
    | 'terminal-resize'
    | 'terminal-output'
    | 'terminal-gap'
    | 'terminal-reply'
    | 'terminal-snapshot'
    | 'file-data'
    | 'file-reply';

const frameKindCode = {
    'terminal-input': 1,
    'terminal-resize': 2,
    'terminal-output': 3,
    'terminal-gap': 4,
    'terminal-reply': 5,
    'terminal-snapshot': 6,
    'file-data': 7,
    'file-reply': 8,
} as const satisfies Record<BinaryStreamFrameKind, number>;

const frameKindByCode = new Map<number, BinaryStreamFrameKind>(
    Object.entries(frameKindCode).map(([kind, code]) => [code, kind as BinaryStreamFrameKind]),
);

export interface BinaryStreamFrame {
    final: boolean;
    kind: BinaryStreamFrameKind;
    payload: Uint8Array;
    sequence: number;
}

function assertSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff)
        throw new CaxriError('VALIDATION', 'Binary stream frame sequence is invalid');
}

/**
 * Encodes one bounded WebSocket message without relying on Buffer, keeping the public protocol browser-safe. The
 * fixed-width header lets readers reject malformed or oversized frames before interpreting user-controlled payloads.
 */
export function encodeBinaryStreamFrame(frame: BinaryStreamFrame): Uint8Array {
    assertSequence(frame.sequence);
    if (frame.payload.byteLength > BINARY_STREAM_MAX_CHUNK_BYTES)
        throw new CaxriError('CAPACITY', 'Binary stream frame payload exceeds the chunk limit');
    const encoded = new Uint8Array(BINARY_STREAM_FRAME_HEADER_BYTES + frame.payload.byteLength);
    const view = new DataView(encoded.buffer);
    view.setUint32(0, BINARY_STREAM_MAGIC);
    view.setUint8(4, BINARY_STREAM_PROTOCOL_VERSION);
    view.setUint8(5, frameKindCode[frame.kind]);
    view.setUint16(6, frame.final ? BINARY_STREAM_FINAL_FLAG : 0);
    view.setUint32(8, frame.sequence);
    view.setUint32(12, frame.payload.byteLength);
    encoded.set(frame.payload, BINARY_STREAM_FRAME_HEADER_BYTES);
    return encoded;
}

/**
 * Decodes exactly one WebSocket message. Unknown versions, kinds, flags, trailing bytes, and oversized chunks fail
 * closed so a future framing change can never be misread as today's protocol.
 */
export function decodeBinaryStreamFrame(source: Uint8Array): BinaryStreamFrame {
    if (source.byteLength < BINARY_STREAM_FRAME_HEADER_BYTES)
        throw new CaxriError('VALIDATION', 'Binary stream frame is truncated');
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const magic = view.getUint32(0);
    const version = view.getUint8(4);
    const kind = frameKindByCode.get(view.getUint8(5));
    if (magic !== BINARY_STREAM_MAGIC || version !== BINARY_STREAM_PROTOCOL_VERSION || !kind)
        throw new CaxriError('VALIDATION', 'Binary stream frame header is incompatible');
    const flags = view.getUint16(6);
    if ((flags & ~BINARY_STREAM_FINAL_FLAG) !== 0)
        throw new CaxriError('VALIDATION', 'Binary stream frame flags are invalid');
    const sequence = view.getUint32(8);
    const payloadBytes = view.getUint32(12);
    if (payloadBytes > BINARY_STREAM_MAX_CHUNK_BYTES)
        throw new CaxriError('CAPACITY', 'Binary stream frame payload exceeds the chunk limit');
    if (source.byteLength !== BINARY_STREAM_FRAME_HEADER_BYTES + payloadBytes)
        throw new CaxriError('VALIDATION', 'Binary stream frame length is invalid');
    return {
        final: (flags & BINARY_STREAM_FINAL_FLAG) !== 0,
        kind,
        payload: source.slice(BINARY_STREAM_FRAME_HEADER_BYTES),
        sequence,
    };
}

export type BinaryStreamCloseReason =
    | 'protocol-error'
    | 'unauthorized'
    | 'scope-mismatch'
    | 'ticket-expired'
    | 'stale-generation'
    | 'payload-too-large'
    | 'capacity-exceeded'
    | 'server-unavailable'
    | 'completed';

export const binaryStreamCloseCodes = {
    'protocol-error': 4400,
    'unauthorized': 4401,
    'scope-mismatch': 4403,
    'ticket-expired': 4408,
    'stale-generation': 4409,
    'payload-too-large': 4413,
    'capacity-exceeded': 4429,
    'server-unavailable': 4503,
    'completed': 4000,
} as const satisfies Record<BinaryStreamCloseReason, number>;

export function binaryStreamAuthorization(ticket: string): string {
    return `Bearer ${binaryStreamTicketSchema.parse(ticket)}`;
}

import { Buffer } from 'node:buffer';

import type {
    BinaryStreamFrame,
    BinaryStreamOperation,
    BinaryStreamReply,
    BinaryStreamTicketGrant,
    ServerControlEndpoint,
    ServerEvent,
} from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_BUFFERED_BYTES,
    BINARY_STREAM_MAX_CHUNK_BYTES,
    binaryStreamAuthorization,
    binaryStreamReplySchema,
    CaxriError,
    decodeBinaryStreamFrame,
    encodeBinaryStreamFrame,
} from '@caxri/protocol';
import type { RawData } from 'ws';
import WebSocket from 'ws';

export interface FrameAccumulator {
    byteLength: number;
    chunks: Uint8Array[];
    kind: BinaryStreamFrame['kind'];
    sequence: number;
}

export interface BinaryStreamClientOptions {
    emitEvent(event: Extract<ServerEvent, { event: 'terminal.output' }>): void;
    endpoint: ServerControlEndpoint;
    issueTicket(id: string, operation: BinaryStreamOperation): Promise<BinaryStreamTicketGrant>;
    onTerminalTransportFailure(): void;
    timeoutMs: number;
}

export abstract class ClientBinarySocket {
    private accumulator?: FrameAccumulator;
    private isOpen = false;
    private readonly opened = Promise.withResolvers<void>();
    protected readonly socket: WebSocket;
    protected readonly writer: ClientSocketWriter;

    constructor(
        endpoint: ServerControlEndpoint,
        grant: BinaryStreamTicketGrant,
        timeoutMs: number,
    ) {
        this.socket = new WebSocket(streamUrl(endpoint, grant.path), {
            headers: { authorization: binaryStreamAuthorization(grant.ticket) },
            maxPayload: BINARY_STREAM_MAX_CHUNK_BYTES + 16,
        });
        this.writer = new ClientSocketWriter(this.socket);
        const timer = setTimeout(() => {
            this.opened.reject(new CaxriError('TIMEOUT', 'Caxri Server stream timed out'));
            this.socket.terminate();
        }, timeoutMs);
        this.socket.once('open', () => {
            clearTimeout(timer);
            this.isOpen = true;
            this.opened.resolve();
        });
        this.socket.on('message', (data, isBinary) => this.receive(data, isBinary));
        this.socket.once('close', (code, reason) => {
            clearTimeout(timer);
            if (!this.isOpen) this.opened.reject(streamCloseError(code, reason.toString()));
            this.handleClose(code, reason.toString());
        });
        this.socket.on('error', () => {});
    }

    private receive(data: RawData, isBinary: boolean): void {
        if (!isBinary) {
            this.fail(new CaxriError('VALIDATION', 'Binary stream received a text frame'));
            return;
        }
        try {
            this.handleFrame(decodeBinaryStreamFrame(rawBytes(data)));
        } catch (error) {
            this.fail(error);
        }
    }

    protected waitForOpen(): Promise<void> {
        return this.opened.promise;
    }

    protected collect(frame: BinaryStreamFrame, maximumBytes: number): Uint8Array | undefined {
        this.accumulator ??= {
            byteLength: 0,
            chunks: [],
            kind: frame.kind,
            sequence: frame.sequence,
        };
        if (this.accumulator.kind !== frame.kind || this.accumulator.sequence !== frame.sequence)
            throw new CaxriError('VALIDATION', 'Binary stream frame group was interleaved');
        this.accumulator.byteLength += frame.payload.byteLength;
        if (this.accumulator.byteLength > maximumBytes)
            throw new CaxriError('CAPACITY', 'Binary stream input exceeded its byte budget');
        this.accumulator.chunks.push(frame.payload);
        if (!frame.final) return;
        const completed = combine(this.accumulator.chunks, this.accumulator.byteLength);
        this.accumulator = undefined;
        return completed;
    }

    protected assertNoPartialGroup(): void {
        if (this.accumulator)
            throw new CaxriError('VALIDATION', 'Binary stream frame group was interleaved');
    }

    protected close(): void {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.close(4000, 'completed');
        else if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    }

    protected abstract fail(error: unknown): void;
    protected abstract handleClose(code: number, reason: string): void;
    protected abstract handleFrame(frame: BinaryStreamFrame): void;
}

export class ClientSocketWriter {
    private outbound = Promise.resolve();
    private queuedPayloadBytes = 0;

    constructor(private readonly socket: WebSocket) {}

    private async send(frame: BinaryStreamFrame): Promise<void> {
        const encoded = encodeBinaryStreamFrame(frame);
        if (
            this.socket.readyState !== WebSocket.OPEN ||
            this.socket.bufferedAmount + encoded.byteLength > BINARY_STREAM_MAX_BUFFERED_BYTES
        )
            throw new CaxriError('CAPACITY', 'Binary stream output exceeded its high-water mark');
        await new Promise<void>((resolve, reject) => {
            this.socket.send(encoded, { binary: true }, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    /**
     * Builds one promise tail for the payload so each WebSocket callback remains the backpressure boundary without
     * awaiting inside the chunking loop.
     */
    private sendPayload(
        kind: BinaryStreamFrame['kind'],
        sequence: number,
        payload: Uint8Array,
    ): Promise<void> {
        if (payload.byteLength === 0) return this.send({ final: true, kind, payload, sequence });

        let sent = Promise.resolve();
        for (let offset = 0; offset < payload.byteLength; offset += BINARY_STREAM_MAX_CHUNK_BYTES) {
            const end = Math.min(payload.byteLength, offset + BINARY_STREAM_MAX_CHUNK_BYTES);
            const frame = {
                final: end === payload.byteLength,
                kind,
                payload: payload.subarray(offset, end),
                sequence,
            } satisfies BinaryStreamFrame;
            // eslint-disable-next-line unicorn/prefer-await -- the promise tail preserves WebSocket callback backpressure without an await inside this loop
            sent = sent.then(() => this.send(frame));
        }
        return sent;
    }

    sendChunks(
        kind: BinaryStreamFrame['kind'],
        sequence: number,
        payload: Uint8Array,
    ): Promise<void> {
        if (
            this.queuedPayloadBytes > 0 &&
            this.queuedPayloadBytes + payload.byteLength > BINARY_STREAM_MAX_BUFFERED_BYTES
        )
            return Promise.reject(
                new CaxriError('CAPACITY', 'Binary stream request queue exceeded its byte budget'),
            );
        this.queuedPayloadBytes += payload.byteLength;
        const action = async (): Promise<void> => {
            try {
                await this.sendPayload(kind, sequence, payload);
            } finally {
                this.queuedPayloadBytes -= payload.byteLength;
            }
        };
        // eslint-disable-next-line unicorn/prefer-await -- this promise tail serializes frame groups across callers
        const scheduled = this.outbound.then(action);
        // eslint-disable-next-line unicorn/prefer-await -- callers retain the failure while the internal queue stays usable
        this.outbound = scheduled.catch(() => {});
        return scheduled;
    }
}

function rawBytes(data: RawData): Uint8Array {
    if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(Buffer.concat(data));
}

function combine(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
    const combined = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}

function streamUrl(endpoint: ServerControlEndpoint, path: string): string {
    return `${endpoint.protocol}://${endpoint.host}:${endpoint.port}${path}`;
}

export function streamCloseError(code: number, reason: string): CaxriError {
    if (reason === 'payload-too-large' || reason === 'capacity-exceeded')
        return new CaxriError('CAPACITY', 'Binary stream capacity was exceeded');
    if (reason === 'unauthorized' || reason === 'scope-mismatch')
        return new CaxriError('FORBIDDEN', 'Binary stream authorization failed');
    if (reason === 'ticket-expired' || reason === 'stale-generation')
        return new CaxriError('CONFLICT', 'Binary stream attachment became stale');
    return new CaxriError(
        'UNAVAILABLE',
        code === 1006 ? 'Caxri Server stream connection closed' : 'Caxri Server stream unavailable',
    );
}

export function parseReply(payload: Uint8Array): BinaryStreamReply {
    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
        throw new CaxriError('VALIDATION', 'Binary stream reply is not valid UTF-8');
    }
    return binaryStreamReplySchema.parse(JSON.parse(source) as unknown);
}

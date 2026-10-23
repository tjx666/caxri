import type {
    BinaryStreamCloseReason,
    BinaryStreamFrame,
    BinaryStreamOperation,
    BinaryStreamReply,
    CommandDispatcher,
    CommandExecutionContext,
    CommandReplyEnvelope,
    FileDocument,
    ProtocolEventEnvelope,
    TerminalSnapshot,
    TransientServerEvent,
} from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_BUFFERED_BYTES,
    BINARY_STREAM_MAX_CHUNK_BYTES,
    BINARY_STREAM_MAX_FILE_CONTENT_BYTES,
    BINARY_STREAM_MAX_REPLY_BYTES,
    BINARY_STREAM_MAX_TERMINAL_INPUT_BYTES,
    BINARY_STREAM_MAX_TERMINAL_RESULT_BYTES,
    binaryStreamCloseCodes,
    binaryStreamReplySchema,
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    decodeBinaryStreamFrame,
    encodeBinaryStreamFrame,
    parseCaxriRequest,
    toWireError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { RawData } from 'ws';
import WebSocket from 'ws';

import { combineBinaryChunks, rawBinaryBytes } from './binary-stream-bytes';
import type { BinaryStreamClaim } from './binary-stream-control';
import type { TerminalDetachTransition } from './terminal-stream-lifecycle';
import { TerminalStreamLifecycle } from './terminal-stream-lifecycle';

type StreamMethod = BinaryStreamOperation['method'];
type TerminalStreamOperation = Extract<BinaryStreamOperation, { terminalId: string }>;

interface BinaryStreamRuntimeOptions {
    dispatch: CommandDispatcher;
    isDesktopConnectionCurrent(connectionId: string): boolean;
    logger?: BinaryStreamMetricSink;
    refreshContext?(context: CommandExecutionContext): CommandExecutionContext;
}

interface BinaryStreamMetricSink {
    recordMetric?: StructuredLogger['recordMetric'];
}

interface BinarySession {
    readonly connectionId: string;
    close(reason: BinaryStreamCloseReason): void;
}

function isTerminalOperation(
    operation: BinaryStreamOperation,
): operation is TerminalStreamOperation {
    return 'terminalId' in operation;
}

function closeReason(error: unknown): BinaryStreamCloseReason {
    return error instanceof CaxriError && error.code === 'CAPACITY'
        ? 'capacity-exceeded'
        : 'protocol-error';
}

function inboundCloseReason(error: unknown): BinaryStreamCloseReason {
    return error instanceof CaxriError && error.code === 'CAPACITY'
        ? 'payload-too-large'
        : 'protocol-error';
}

function commandFailure(id: string, error: unknown): CommandReplyEnvelope {
    return {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id,
        ok: false,
        error: toWireError(error),
    };
}

function recordStreamClosed(logger: BinaryStreamMetricSink | undefined): void {
    logger?.recordMetric?.('connection.closed', 1, {
        owner: 'stream',
        phase: 'shutdown',
        outcome: 'success',
    });
}

class BinarySocketWriter {
    constructor(
        private readonly socket: WebSocket,
        private readonly logger: BinaryStreamMetricSink | undefined,
    ) {}

    async send(frame: BinaryStreamFrame): Promise<void> {
        const encoded = encodeBinaryStreamFrame(frame);
        const bufferedBytes = this.socket.bufferedAmount + encoded.byteLength;
        this.logger?.recordMetric?.('connection.buffered_bytes', bufferedBytes, {
            owner: 'stream',
            phase: 'transfer',
            outcome: bufferedBytes > BINARY_STREAM_MAX_BUFFERED_BYTES ? 'overflow' : 'success',
        });
        if (
            this.socket.readyState !== WebSocket.OPEN ||
            bufferedBytes > BINARY_STREAM_MAX_BUFFERED_BYTES
        )
            throw new CaxriError('CAPACITY', 'Binary stream output exceeded its high-water mark');
        await new Promise<void>((resolve, reject) => {
            this.socket.send(encoded, { binary: true }, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    async sendChunks(
        kind: BinaryStreamFrame['kind'],
        sequence: number,
        payload: Uint8Array,
    ): Promise<void> {
        if (payload.byteLength === 0) {
            await this.send({ final: true, kind, payload, sequence });
            return;
        }
        for (let offset = 0; offset < payload.byteLength; offset += BINARY_STREAM_MAX_CHUNK_BYTES) {
            const end = Math.min(payload.byteLength, offset + BINARY_STREAM_MAX_CHUNK_BYTES);
            // eslint-disable-next-line no-await-in-loop -- each chunk is the stream's backpressure boundary
            await this.send({
                final: end === payload.byteLength,
                kind,
                payload: payload.subarray(offset, end),
                sequence,
            });
        }
    }

    close(reason: BinaryStreamCloseReason): void {
        if (this.socket.readyState === WebSocket.OPEN)
            this.socket.close(binaryStreamCloseCodes[reason], reason);
        else if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    }
}

abstract class BaseBinarySession implements BinarySession {
    protected closed = false;
    protected readonly writer: BinarySocketWriter;
    readonly connectionId: string;

    constructor(
        protected readonly socket: WebSocket,
        protected readonly claim: BinaryStreamClaim,
        private readonly logger: BinaryStreamMetricSink | undefined,
        private readonly onClosed: () => void,
    ) {
        this.connectionId = claim.connectionId;
        this.writer = new BinarySocketWriter(socket, this.logger);
        socket.once('close', () => {
            if (this.closed) return;
            this.closed = true;
            recordStreamClosed(this.logger);
            this.onClosed();
        });
        socket.on('error', () => {});
    }

    close(reason: BinaryStreamCloseReason): void {
        if (this.closed) return;
        this.closed = true;
        recordStreamClosed(this.logger);
        this.writer.close(reason);
        this.onClosed();
    }

    protected fail(error: unknown): void {
        this.close(closeReason(error));
    }
}

interface ExecuteStreamCommand {
    (
        id: string,
        method: StreamMethod,
        parameters: unknown,
        context: CommandExecutionContext,
    ): Promise<CommandReplyEnvelope>;
}

function encodeReply(reply: BinaryStreamReply): Uint8Array {
    const encoded = new TextEncoder().encode(JSON.stringify(binaryStreamReplySchema.parse(reply)));
    if (encoded.byteLength > BINARY_STREAM_MAX_REPLY_BYTES)
        throw new CaxriError('CAPACITY', 'Binary stream reply metadata exceeds its byte budget');
    return encoded;
}

function errorStreamReply(
    method: StreamMethod,
    reply: Extract<CommandReplyEnvelope, { ok: false }>,
): BinaryStreamReply {
    return { id: reply.id!, method, ok: false, error: reply.error };
}

class TerminalBinarySession extends BaseBinarySession {
    private activeInput?: { byteLength: number; chunks: Uint8Array[]; sequence: number };
    private commandChain = Promise.resolve();
    private completing = false;
    private droppedBytes = 0;
    private gapScheduled = false;
    private lastClientSequence: number;
    private outbound = Promise.resolve();
    private outputSequence = 0;
    private oneShotSubmitted = false;
    private queuedOutputBytes = 0;
    readonly terminalId: string;

    constructor(
        socket: WebSocket,
        claim: BinaryStreamClaim,
        private readonly execute: ExecuteStreamCommand,
        logger: BinaryStreamMetricSink | undefined,
        onClosed: () => void,
    ) {
        super(socket, claim, logger, onClosed);
        if (!isTerminalOperation(claim.operation))
            throw new CaxriError('FORBIDDEN', 'File scope cannot open a Terminal stream');
        this.terminalId = claim.operation.terminalId;
        this.lastClientSequence = claim.operation.method === 'terminal.attach' ? 0 : -1;
        socket.on('message', (data, isBinary) => this.receive(data, isBinary));
        if (claim.operation.method === 'terminal.attach') this.startAttachment();
        else if (claim.operation.method === 'terminal.resize') this.startOneShotResize();
    }

    private queueOutbound(action: () => Promise<void>): Promise<void> {
        // eslint-disable-next-line unicorn/prefer-await -- promise chaining is the per-stream ordering primitive
        this.outbound = this.outbound.then(action).catch((error: unknown) => this.fail(error));
        return this.outbound;
    }

    private async sendReply(
        sequence: number,
        method: 'terminal.attach' | 'terminal.input' | 'terminal.resize',
        reply: CommandReplyEnvelope,
    ): Promise<void> {
        if (!reply.ok) {
            await this.writer.sendChunks(
                'terminal-reply',
                sequence,
                encodeReply(errorStreamReply(method, reply)),
            );
            return;
        }
        if (method !== 'terminal.attach') {
            await this.writer.sendChunks(
                'terminal-reply',
                sequence,
                encodeReply({ id: reply.id!, method, ok: true, result: { kind: 'empty' } }),
            );
            return;
        }
        const snapshot = reply.result as TerminalSnapshot | null;
        const snapshotBytes = snapshot
            ? new TextEncoder().encode(snapshot.payload)
            : new Uint8Array();
        if (snapshotBytes.byteLength > BINARY_STREAM_MAX_TERMINAL_RESULT_BYTES)
            throw new CaxriError('CAPACITY', 'Terminal snapshot exceeds its stream byte budget');
        await this.writer.sendChunks(
            'terminal-reply',
            sequence,
            encodeReply({
                id: reply.id!,
                method,
                ok: true,
                result: {
                    kind: 'terminal-attachment',
                    snapshot: snapshot
                        ? {
                              terminalId: snapshot.terminalId,
                              encodingVersion: snapshot.encodingVersion,
                              cols: snapshot.cols,
                              rows: snapshot.rows,
                              lineCount: snapshot.lineCount,
                              byteCount: snapshot.byteCount,
                              payloadBytes: snapshotBytes.byteLength,
                              ...(snapshot.oscLinks && { oscLinks: snapshot.oscLinks }),
                              updatedAt: snapshot.updatedAt,
                          }
                        : null,
                },
            }),
        );
        if (snapshot) await this.writer.sendChunks('terminal-snapshot', sequence, snapshotBytes);
    }

    private startAttachment(): void {
        const operation = this.claim.operation;
        if (operation.method !== 'terminal.attach') return;
        this.commandChain = (async () => {
            const reply = await this.execute(
                this.claim.requestId,
                operation.method,
                {
                    terminalId: operation.terminalId,
                    ...(operation.cols !== undefined && {
                        cols: operation.cols,
                        rows: operation.rows,
                    }),
                },
                this.claim.context,
            );
            await this.sendReply(0, operation.method, reply);
            if (!reply.ok) this.close('completed');
        })();
        // eslint-disable-next-line unicorn/prefer-await -- the outbound barrier must share this in-flight initialization
        this.outbound = this.commandChain.catch((error: unknown) => this.fail(error));
    }

    private startOneShotResize(): void {
        const operation = this.claim.operation;
        if (operation.method !== 'terminal.resize') return;
        this.commandChain = (async () => {
            const reply = await this.execute(
                this.claim.requestId,
                operation.method,
                operation,
                this.claim.context,
            );
            await this.sendReply(0, operation.method, reply);
            this.close('completed');
        })();
        // eslint-disable-next-line unicorn/prefer-await -- the outbound barrier must share this in-flight initialization
        this.outbound = this.commandChain.catch((error: unknown) => this.fail(error));
    }

    private receive(data: RawData, isBinary: boolean): void {
        if (this.closed || this.completing) return;
        if (!isBinary) {
            this.close('protocol-error');
            return;
        }
        try {
            const frame = decodeBinaryStreamFrame(rawBinaryBytes(data));
            if (frame.kind === 'terminal-input') this.receiveInput(frame);
            else if (frame.kind === 'terminal-resize') this.receiveResize(frame);
            else this.close('scope-mismatch');
        } catch (error) {
            this.close(inboundCloseReason(error));
        }
    }

    private receiveInput(frame: BinaryStreamFrame): void {
        if (
            (this.claim.operation.method !== 'terminal.attach' &&
                this.claim.operation.method !== 'terminal.input') ||
            (this.claim.operation.method === 'terminal.input' && this.oneShotSubmitted) ||
            frame.sequence <= this.lastClientSequence
        ) {
            this.close('scope-mismatch');
            return;
        }
        this.activeInput ??= { byteLength: 0, chunks: [], sequence: frame.sequence };
        if (this.activeInput.sequence !== frame.sequence) {
            this.close('protocol-error');
            return;
        }
        this.activeInput.byteLength += frame.payload.byteLength;
        if (this.activeInput.byteLength > BINARY_STREAM_MAX_TERMINAL_INPUT_BYTES) {
            this.close('payload-too-large');
            return;
        }
        this.activeInput.chunks.push(frame.payload);
        if (!frame.final) return;
        const input = this.activeInput;
        this.activeInput = undefined;
        this.lastClientSequence = frame.sequence;
        if (this.claim.operation.method === 'terminal.input') this.oneShotSubmitted = true;
        if (
            this.claim.operation.method === 'terminal.input' &&
            input.byteLength !== this.claim.operation.byteLength
        ) {
            this.close('scope-mismatch');
            return;
        }
        let data: string;
        try {
            data = new TextDecoder('utf-8', { fatal: true }).decode(
                combineBinaryChunks(input.chunks, input.byteLength),
            );
        } catch {
            this.close('protocol-error');
            return;
        }
        this.queueCommand(frame.sequence, 'terminal.input', {
            terminalId: this.terminalId,
            data,
        });
    }

    private receiveResize(frame: BinaryStreamFrame): void {
        if (
            this.claim.operation.method !== 'terminal.attach' ||
            !frame.final ||
            frame.sequence <= this.lastClientSequence ||
            frame.payload.byteLength !== 4
        ) {
            this.close('scope-mismatch');
            return;
        }
        this.lastClientSequence = frame.sequence;
        const view = new DataView(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength,
        );
        this.queueCommand(frame.sequence, 'terminal.resize', {
            terminalId: this.terminalId,
            cols: view.getUint16(0),
            rows: view.getUint16(2),
        });
    }

    private queueCommand(
        sequence: number,
        method: 'terminal.input' | 'terminal.resize',
        parameters: unknown,
    ): void {
        // eslint-disable-next-line unicorn/prefer-await -- command arrival order is the Terminal stream contract
        this.commandChain = this.commandChain.then(async () => {
            const id =
                this.claim.operation.method === method
                    ? this.claim.requestId
                    : `${this.claim.requestId}:${sequence}`;
            const reply = await this.execute(id, method, parameters, this.claim.context);
            await this.queueOutbound(() => this.sendReply(sequence, method, reply));
            if (this.claim.operation.method !== 'terminal.attach') this.close('completed');
        });
        // `observe` converts the detached command failure into a typed stream close.
        void this.observe(this.commandChain);
    }

    private async observe(promise: Promise<void>): Promise<void> {
        try {
            await promise;
        } catch (error) {
            this.fail(error);
        }
    }

    private scheduleGap(bytes: number): void {
        this.droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.droppedBytes + bytes);
        if (this.gapScheduled) return;
        this.gapScheduled = true;
        const sequence = (this.outputSequence += 1);
        // `queueOutbound` owns transport failure handling.
        void this.queueOutbound(async () => {
            this.gapScheduled = false;
            const droppedBytes = this.droppedBytes;
            this.droppedBytes = 0;
            const payload = new Uint8Array(8);
            new DataView(payload.buffer).setBigUint64(0, BigInt(droppedBytes));
            await this.writer.send({
                final: true,
                kind: 'terminal-gap',
                payload,
                sequence,
            });
        });
    }

    output(data: string, upstreamDroppedBytes = 0): void {
        if (this.closed || this.completing) return;
        const payload = new TextEncoder().encode(data);
        if (upstreamDroppedBytes > 0) {
            this.scheduleGap(upstreamDroppedBytes + payload.byteLength);
            return;
        }
        if (this.queuedOutputBytes + payload.byteLength > BINARY_STREAM_MAX_BUFFERED_BYTES) {
            this.scheduleGap(payload.byteLength);
            return;
        }
        this.queuedOutputBytes += payload.byteLength;
        const sequence = (this.outputSequence += 1);
        const task = this.queueOutbound(() =>
            this.writer.sendChunks('terminal-output', sequence, payload),
        );
        const release = (): void => {
            this.queuedOutputBytes -= payload.byteLength;
        };
        // This observer only releases the byte reservation; `queueOutbound` owns transport failure handling.
        void (async () => {
            try {
                await task;
            } finally {
                release();
            }
        })();
    }

    /**
     * A Terminal can exit before Terminal Host's reply for the input that caused that exit reaches Server Core. Drain
     * every command already admitted on this attachment so the client receives its exact acknowledgement before the
     * normal completed close.
     */
    completeAfterPending(): void {
        if (this.closed || this.completing) return;
        this.completing = true;
        const completion = (async () => {
            await this.commandChain;
            await this.outbound;
            this.close('completed');
        })();
        // `observe` converts any pending transport failure into the typed stream close.
        void this.observe(completion);
    }
}

class FileBinarySession extends BaseBinarySession {
    private byteLength = 0;
    private readonly chunks: Uint8Array[] = [];
    private isSubmitted = false;

    constructor(
        socket: WebSocket,
        claim: BinaryStreamClaim,
        private readonly execute: ExecuteStreamCommand,
        logger: BinaryStreamMetricSink | undefined,
        onClosed: () => void,
    ) {
        super(socket, claim, logger, onClosed);
        socket.on('message', (data, isBinary) => this.receive(data, isBinary));
        if (claim.operation.method === 'files.read') {
            // `startRead` owns transport failure handling and closes the one-shot stream.
            void this.startRead();
        }
    }

    private async sendResult(method: 'files.read' | 'files.write', reply: CommandReplyEnvelope) {
        if (!reply.ok) {
            await this.writer.sendChunks(
                'file-reply',
                0,
                encodeReply(errorStreamReply(method, reply)),
            );
            this.close('completed');
            return;
        }
        const document = reply.result as FileDocument;
        const content = new TextEncoder().encode(document.content);
        if (content.byteLength > BINARY_STREAM_MAX_FILE_CONTENT_BYTES)
            throw new CaxriError('CAPACITY', 'File download exceeds its stream byte budget');
        await this.writer.sendChunks(
            'file-reply',
            0,
            encodeReply({
                id: reply.id!,
                method,
                ok: true,
                result: {
                    kind: 'file-document',
                    readOnly: document.readOnly,
                    path: document.path,
                    mtimeMs: document.mtimeMs,
                    size: document.size,
                    contentBytes: content.byteLength,
                },
            }),
        );
        await this.writer.sendChunks('file-data', 0, content);
        this.close('completed');
    }

    private async startRead(): Promise<void> {
        const operation = this.claim.operation;
        if (operation.method !== 'files.read') return;
        try {
            const reply = await this.execute(
                this.claim.requestId,
                operation.method,
                { sessionId: operation.sessionId, path: operation.path },
                this.claim.context,
            );
            await this.sendResult(operation.method, reply);
        } catch (error) {
            this.fail(error);
        }
    }

    private receive(data: RawData, isBinary: boolean): void {
        if (this.closed) return;
        if (!isBinary || this.claim.operation.method !== 'files.write' || this.isSubmitted) {
            this.close('scope-mismatch');
            return;
        }
        try {
            const frame = decodeBinaryStreamFrame(rawBinaryBytes(data));
            if (frame.kind !== 'file-data' || frame.sequence !== 0) {
                this.close('scope-mismatch');
                return;
            }
            this.byteLength += frame.payload.byteLength;
            if (this.byteLength > this.claim.operation.byteLength) {
                this.close('payload-too-large');
                return;
            }
            this.chunks.push(frame.payload);
            if (frame.final) {
                this.isSubmitted = true;
                // `finishWrite` owns transport failure handling and closes the one-shot stream.
                void this.finishWrite();
            }
        } catch (error) {
            this.close(inboundCloseReason(error));
        }
    }

    private async finishWrite(): Promise<void> {
        const operation = this.claim.operation;
        if (operation.method !== 'files.write' || this.byteLength !== operation.byteLength) {
            this.close('scope-mismatch');
            return;
        }
        let content: string;
        try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(
                combineBinaryChunks(this.chunks, this.byteLength),
            );
            this.chunks.length = 0;
        } catch {
            this.close('protocol-error');
            return;
        }
        try {
            const reply = await this.execute(
                this.claim.requestId,
                operation.method,
                { sessionId: operation.sessionId, path: operation.path, content },
                this.claim.context,
            );
            await this.sendResult(operation.method, reply);
        } catch (error) {
            this.fail(error);
        }
    }
}

/**
 * Executes authenticated stream claims while keeping Terminal output and file bodies off the JSON control lane.
 */
export class BinaryStreamRuntime {
    private readonly sessions = new Set<BinarySession>();
    private readonly terminalLifecycle = new TerminalStreamLifecycle();
    private readonly terminalSessions = new Map<string, TerminalBinarySession>();
    private execute: ExecuteStreamCommand = async (id, method, parameters, context) => {
        if (
            context.principal.kind === 'desktop' &&
            !this.options.isDesktopConnectionCurrent(context.connection!.connectionId)
        )
            return commandFailure(
                id,
                new CaxriError('CONFLICT', 'Desktop capability lease is stale'),
            );
        try {
            const refreshed = this.options.refreshContext?.(context) ?? context;
            const admission = await this.options.dispatch.admit(
                { protocolVersion: CAXRI_PROTOCOL_VERSION, id, method, params: parameters },
                { ...refreshed, connection: context.connection },
            );
            return await admission.reply;
        } catch (error) {
            return commandFailure(id, error);
        }
    };

    constructor(private readonly options: BinaryStreamRuntimeOptions) {}

    private async executeTerminal(
        claim: BinaryStreamClaim,
        id: string,
        method: StreamMethod,
        parameters: unknown,
        context: CommandExecutionContext,
    ): Promise<CommandReplyEnvelope> {
        if (!isTerminalOperation(claim.operation) || claim.terminalGeneration === undefined)
            return commandFailure(
                id,
                new CaxriError('VALIDATION', 'Terminal stream generation is missing'),
            );
        try {
            return await this.terminalLifecycle.run(
                claim.operation.terminalId,
                claim.terminalGeneration,
                () => this.execute(id, method, parameters, context),
            );
        } catch (error) {
            return commandFailure(id, error);
        }
    }

    private terminalKey(session: TerminalBinarySession): string {
        return `${session.connectionId}:${session.terminalId}`;
    }

    accept(socket: WebSocket, claim: BinaryStreamClaim): void {
        let session: BinarySession;
        const onClosed = (): void => {
            this.sessions.delete(session);
            if (
                session instanceof TerminalBinarySession &&
                this.terminalSessions.get(this.terminalKey(session)) === session
            )
                this.terminalSessions.delete(this.terminalKey(session));
        };
        if (claim.operation.method.startsWith('terminal.')) {
            const terminal = new TerminalBinarySession(
                socket,
                claim,
                (id, method, parameters, context) =>
                    this.executeTerminal(claim, id, method, parameters, context),
                this.options.logger,
                onClosed,
            );
            session = terminal;
            if (
                claim.operation.method === 'terminal.attach' &&
                claim.terminalGeneration !== undefined &&
                this.terminalLifecycle.isCurrent(
                    claim.operation.terminalId,
                    claim.terminalGeneration,
                )
            ) {
                const key = this.terminalKey(terminal);
                this.terminalSessions.get(key)?.close('completed');
                this.terminalSessions.set(key, terminal);
            }
        } else
            session = new FileBinarySession(
                socket,
                claim,
                this.execute,
                this.options.logger,
                onClosed,
            );
        this.sessions.add(session);
    }

    deliver(event: ProtocolEventEnvelope | TransientServerEvent): boolean {
        const projected = typeof event.event === 'string' ? event : event.event;
        if (projected.event === 'terminal.output') {
            let isDelivered = false;
            for (const session of this.terminalSessions.values()) {
                if (session.terminalId !== projected.payload.terminalId) continue;
                session.output(projected.payload.data, projected.payload.droppedBytes);
                isDelivered = true;
            }
            return isDelivered;
        }
        if (projected.event === 'terminal.exit')
            for (const session of this.terminalSessions.values())
                if (session.terminalId === projected.payload.terminalId)
                    session.completeAfterPending();
        return false;
    }

    revokeConnection(connectionId: string, reason: BinaryStreamCloseReason): void {
        for (const session of this.sessions)
            if (session.connectionId === connectionId) session.close(reason);
    }

    beginTerminalDetachRequest(parameters: unknown): TerminalDetachTransition | undefined {
        try {
            const request = parseCaxriRequest('terminal.detach', parameters);
            return request.method === 'terminal.detach'
                ? this.terminalLifecycle.beginDetach(request.params.terminalId)
                : undefined;
        } catch {
            return;
        }
    }

    terminalGeneration(operation: BinaryStreamOperation): number | undefined {
        return isTerminalOperation(operation)
            ? this.terminalLifecycle.generationFor(operation.terminalId)
            : undefined;
    }

    close(): void {
        for (const session of this.sessions) session.close('server-unavailable');
        this.sessions.clear();
        this.terminalLifecycle.clear();
        this.terminalSessions.clear();
    }
}

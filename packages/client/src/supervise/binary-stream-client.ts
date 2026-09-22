import { randomUUID } from 'node:crypto';

import type {
    BinaryStreamFrame,
    BinaryStreamOperation,
    BinaryStreamReply,
    BinaryStreamTerminalSnapshotMetadata,
    BinaryStreamTicketGrant,
    CaxriMethod,
    FileDocument,
    TerminalSnapshot,
} from '@caxri/protocol';
import {
    BINARY_STREAM_MAX_BUFFERED_BYTES,
    BINARY_STREAM_MAX_FILE_CONTENT_BYTES,
    BINARY_STREAM_MAX_FILE_UPLOAD_BYTES,
    BINARY_STREAM_MAX_REPLY_BYTES,
    BINARY_STREAM_MAX_TERMINAL_RESULT_BYTES,
    CaxriError,
    fromWireError,
    isBinaryStreamMethod,
    isNonExpiringServerOperation,
    parseCaxriRequest,
    parseCaxriResult,
} from '@caxri/protocol';

import type { BinaryStreamClientOptions } from './binary-stream-client-support.js';
import {
    ClientBinarySocket,
    parseReply,
    streamCloseError,
} from './binary-stream-client-support.js';
import type { TerminalOperationLease } from './terminal-operation-queue.js';
import { TerminalOperationQueue } from './terminal-operation-queue.js';

interface TerminalDetachTransition {
    cancel(): void;
    complete(): void;
}

interface PendingTerminalRequest {
    method: 'terminal.attach' | 'terminal.input' | 'terminal.resize';
    reject(error: Error): void;
    resolve(result: TerminalSnapshot | null): void;
    snapshot?: BinaryStreamTerminalSnapshotMetadata;
    timer?: NodeJS.Timeout;
}

class TerminalStreamClient extends ClientBinarySocket {
    private closed = false;
    private drain?: PromiseWithResolvers<void>;
    private failed = false;
    private nextSequence: number;
    private readonly pending = new Map<number, PendingTerminalRequest>();
    private retiring = false;
    readonly terminalId: string;

    private constructor(
        private readonly options: BinaryStreamClientOptions,
        grant: BinaryStreamTicketGrant,
        operation: Extract<BinaryStreamOperation, { terminalId: string }>,
        private readonly isPersistent: boolean,
        private readonly onClosed: () => void,
    ) {
        super(options.endpoint, grant, options.timeoutMs);
        this.terminalId = operation.terminalId;
        this.nextSequence = isPersistent ? 1 : 0;
    }

    // eslint-disable-next-line unicorn/consistent-class-member-order -- factory construction is kept beside the private constructor contract
    static async open(
        options: BinaryStreamClientOptions,
        grant: BinaryStreamTicketGrant,
        operation: Extract<BinaryStreamOperation, { terminalId: string }>,
        onClosed: () => void,
        onCreated: (stream: TerminalStreamClient) => void,
        input?: Uint8Array,
    ): Promise<{ result: TerminalSnapshot | null; stream: TerminalStreamClient }> {
        const isPersistent = operation.method === 'terminal.attach';
        const stream = new TerminalStreamClient(options, grant, operation, isPersistent, onClosed);
        onCreated(stream);
        const pending = stream.expect(0, operation.method);
        try {
            await stream.waitForOpen();
            if (operation.method === 'terminal.input')
                await stream.writer.sendChunks('terminal-input', 0, input ?? new Uint8Array());
        } catch (error) {
            stream.cancel(error);
        }
        return { result: await pending, stream };
    }

    private expect(
        sequence: number,
        method: PendingTerminalRequest['method'],
    ): Promise<TerminalSnapshot | null> {
        return new Promise((resolve, reject) => {
            const timer =
                method === 'terminal.input'
                    ? undefined
                    : setTimeout(() => {
                          this.pending.delete(sequence);
                          this.resolveDrain();
                          reject(
                              new CaxriError('TIMEOUT', `Caxri Server stream timed out: ${method}`),
                          );
                          this.close();
                      }, this.options.timeoutMs);
            this.pending.set(sequence, { method, reject, resolve, ...(timer && { timer }) });
        });
    }

    private resolveDrain(): void {
        if (this.pending.size > 0 || !this.drain) return;
        this.drain.resolve();
        this.drain = undefined;
    }

    private settleError(sequence: number, error: unknown): void {
        const pending = this.pending.get(sequence);
        if (!pending) throw new CaxriError('VALIDATION', 'Binary Terminal reply is unexpected');
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(sequence);
        this.resolveDrain();
        pending.reject(
            error instanceof Error ? error : new Error('Binary Terminal request failed'),
        );
        if (!this.isPersistent || pending.method === 'terminal.attach') this.close();
    }

    private settleResult(sequence: number, result: TerminalSnapshot | null): void {
        const pending = this.pending.get(sequence);
        if (!pending) throw new CaxriError('VALIDATION', 'Binary Terminal reply is unexpected');
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(sequence);
        this.resolveDrain();
        pending.resolve(result);
        if (!this.isPersistent) this.close();
    }

    private handleReply(sequence: number, payload: Uint8Array): void {
        const reply = parseReply(payload);
        const pending = this.pending.get(sequence);
        if (!pending || reply.method !== pending.method)
            throw new CaxriError('VALIDATION', 'Binary Terminal reply method is invalid');
        if (!reply.ok) {
            this.settleError(sequence, fromWireError(reply.error));
            return;
        }
        if (pending.method !== 'terminal.attach') {
            if (reply.result.kind !== 'empty')
                throw new CaxriError('VALIDATION', 'Binary Terminal result kind is invalid');
            this.settleResult(sequence, null);
            return;
        }
        if (reply.result.kind !== 'terminal-attachment')
            throw new CaxriError('VALIDATION', 'Binary Terminal attachment result is invalid');
        if (!reply.result.snapshot) {
            this.settleResult(sequence, null);
            return;
        }
        pending.snapshot = reply.result.snapshot;
    }

    private handleSnapshot(sequence: number, payload: Uint8Array): void {
        const pending = this.pending.get(sequence);
        const metadata = pending?.snapshot;
        if (!pending || !metadata || payload.byteLength !== metadata.payloadBytes)
            throw new CaxriError('VALIDATION', 'Binary Terminal snapshot length is invalid');
        let screen: string;
        try {
            screen = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
            throw new CaxriError('VALIDATION', 'Binary Terminal snapshot is not valid UTF-8');
        }
        this.settleResult(
            sequence,
            parseCaxriResult('terminal.attach', {
                terminalId: metadata.terminalId,
                encodingVersion: metadata.encodingVersion,
                cols: metadata.cols,
                rows: metadata.rows,
                lineCount: metadata.lineCount,
                byteCount: metadata.byteCount,
                payload: screen,
                ...(metadata.oscLinks && { oscLinks: metadata.oscLinks }),
                updatedAt: metadata.updatedAt,
            }),
        );
    }

    protected handleFrame(frame: BinaryStreamFrame): void {
        if (
            frame.kind !== 'terminal-gap' &&
            frame.kind !== 'terminal-output' &&
            frame.kind !== 'terminal-reply' &&
            frame.kind !== 'terminal-snapshot'
        )
            throw new CaxriError('VALIDATION', 'Binary Terminal frame kind is invalid');
        if (frame.kind === 'terminal-gap') {
            this.assertNoPartialGroup();
            if (!frame.final || frame.payload.byteLength !== 8)
                throw new CaxriError('VALIDATION', 'Binary Terminal gap frame is invalid');
            const droppedBytesValue = new DataView(
                frame.payload.buffer,
                frame.payload.byteOffset,
                frame.payload.byteLength,
            ).getBigUint64(0);
            if (droppedBytesValue > BigInt(Number.MAX_SAFE_INTEGER))
                throw new CaxriError(
                    'VALIDATION',
                    'Binary Terminal gap exceeds the safe byte range',
                );
            const droppedBytes = Number(droppedBytesValue);
            this.options.emitEvent({
                event: 'terminal.output',
                payload: { terminalId: this.terminalId, data: '', droppedBytes },
            });
            return;
        }
        const maximumBytes =
            frame.kind === 'terminal-reply'
                ? BINARY_STREAM_MAX_REPLY_BYTES
                : frame.kind === 'terminal-snapshot'
                  ? BINARY_STREAM_MAX_TERMINAL_RESULT_BYTES
                  : BINARY_STREAM_MAX_BUFFERED_BYTES;
        const payload = this.collect(frame, maximumBytes);
        if (!payload) return;
        switch (frame.kind) {
            case 'terminal-reply': {
                this.handleReply(frame.sequence, payload);
                break;
            }
            case 'terminal-snapshot': {
                this.handleSnapshot(frame.sequence, payload);
                break;
            }
            case 'terminal-output': {
                let data: string;
                try {
                    data = new TextDecoder('utf-8', { fatal: true }).decode(payload);
                } catch {
                    throw new CaxriError('VALIDATION', 'Binary Terminal output is not valid UTF-8');
                }
                this.options.emitEvent({
                    event: 'terminal.output',
                    payload: { terminalId: this.terminalId, data },
                });

                break;
            }
            default:
                throw new CaxriError('VALIDATION', 'Binary Terminal frame kind is invalid');
        }
    }

    private async request(
        method: 'terminal.input' | 'terminal.resize',
        payload: Uint8Array,
    ): Promise<null> {
        if (this.closed || this.retiring)
            throw new CaxriError('UNAVAILABLE', 'Binary Terminal stream is closed');
        const sequence = this.nextSequence++;
        const pending = this.expect(sequence, method);
        try {
            await this.writer.sendChunks(
                method === 'terminal.input' ? 'terminal-input' : 'terminal-resize',
                sequence,
                payload,
            );
        } catch (error) {
            this.fail(error);
        }
        await pending;
        return null;
    }

    input(payload: Uint8Array): Promise<null> {
        return this.request('terminal.input', payload);
    }

    resize(cols: number, rows: number): Promise<null> {
        const payload = new Uint8Array(4);
        const view = new DataView(payload.buffer);
        view.setUint16(0, cols);
        view.setUint16(2, rows);
        return this.request('terminal.resize', payload);
    }

    cancel(error: unknown): void {
        this.retiring = true;
        this.fail(error);
    }

    retire(): void {
        this.retiring = true;
        this.close();
    }

    async retireAfterPending(): Promise<void> {
        this.retiring = true;
        if (this.pending.size > 0) {
            this.drain ??= Promise.withResolvers<void>();
            await this.drain.promise;
        }
        this.close();
    }

    protected fail(error: unknown): void {
        this.failed = true;
        const failure =
            error instanceof Error
                ? error
                : new CaxriError('UNAVAILABLE', 'Binary Terminal failed');
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(failure);
        }
        this.pending.clear();
        this.resolveDrain();
        this.close();
    }

    protected handleClose(code: number, reason: string): void {
        if (this.closed) return;
        this.closed = true;
        const error = streamCloseError(code, reason);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.resolveDrain();
        this.onClosed();
        if ((code !== 4000 || this.failed) && this.isPersistent && !this.retiring)
            this.options.onTerminalTransportFailure();
    }
}

class FileStreamClient extends ClientBinarySocket {
    private closed = false;
    private readonly result = Promise.withResolvers<FileDocument>();
    private reply?: Extract<BinaryStreamReply, { ok: true }>;
    private readonly timer?: NodeJS.Timeout;

    private constructor(
        options: BinaryStreamClientOptions,
        grant: BinaryStreamTicketGrant,
        private readonly operation: Extract<BinaryStreamOperation, { sessionId: string }>,
        private readonly onClosed: () => void,
    ) {
        super(options.endpoint, grant, options.timeoutMs);
        if (!isNonExpiringServerOperation(operation.method))
            this.timer = setTimeout(() => {
                this.result.reject(
                    new CaxriError('TIMEOUT', `Caxri Server stream timed out: ${operation.method}`),
                );
                this.close();
            }, options.timeoutMs);
    }

    // eslint-disable-next-line unicorn/consistent-class-member-order -- factory construction is kept beside the private constructor contract
    static async run(
        options: BinaryStreamClientOptions,
        grant: BinaryStreamTicketGrant,
        operation: Extract<BinaryStreamOperation, { sessionId: string }>,
        onClosed: () => void,
        onCreated: (stream: FileStreamClient) => void,
        upload?: Uint8Array,
    ): Promise<FileDocument> {
        const stream = new FileStreamClient(options, grant, operation, onClosed);
        onCreated(stream);
        try {
            await stream.waitForOpen();
            if (operation.method === 'files.write')
                await stream.writer.sendChunks('file-data', 0, upload ?? new Uint8Array());
        } catch (error) {
            stream.cancel(error);
        }
        return stream.result.promise;
    }

    private handleReply(payload: Uint8Array): void {
        const reply = parseReply(payload);
        if (reply.method !== this.operation.method)
            throw new CaxriError('VALIDATION', 'Binary file reply method is invalid');
        if (!reply.ok) {
            if (this.timer) clearTimeout(this.timer);
            this.result.reject(fromWireError(reply.error));
            this.close();
            return;
        }
        if (reply.result.kind !== 'file-document')
            throw new CaxriError('VALIDATION', 'Binary file result kind is invalid');
        if (this.reply)
            throw new CaxriError('VALIDATION', 'Binary file metadata was received twice');
        this.reply = reply;
    }

    protected handleFrame(frame: BinaryStreamFrame): void {
        if ((frame.kind !== 'file-reply' && frame.kind !== 'file-data') || frame.sequence !== 0)
            throw new CaxriError('VALIDATION', 'Binary file frame scope is invalid');
        const maximumBytes =
            frame.kind === 'file-reply'
                ? BINARY_STREAM_MAX_REPLY_BYTES
                : BINARY_STREAM_MAX_FILE_CONTENT_BYTES;
        const payload = this.collect(frame, maximumBytes);
        if (!payload) return;
        if (frame.kind === 'file-reply') {
            this.handleReply(payload);
            return;
        }
        if (this.reply?.result.kind !== 'file-document')
            throw new CaxriError('VALIDATION', 'Binary file data arrived before metadata');
        if (payload.byteLength !== this.reply.result.contentBytes)
            throw new CaxriError('VALIDATION', 'Binary file content length is invalid');
        let content: string;
        try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        } catch {
            throw new CaxriError('VALIDATION', 'Binary file content is not valid UTF-8');
        }
        if (this.timer) clearTimeout(this.timer);
        this.result.resolve(
            parseCaxriResult(this.operation.method, {
                path: this.reply.result.path,
                content,
                mtimeMs: this.reply.result.mtimeMs,
                size: this.reply.result.size,
            }),
        );
        this.close();
    }

    cancel(error: unknown): void {
        this.fail(error);
    }

    protected fail(error: unknown): void {
        if (this.timer) clearTimeout(this.timer);
        this.result.reject(
            error instanceof Error ? error : new CaxriError('UNAVAILABLE', 'Binary file failed'),
        );
        this.close();
    }

    protected handleClose(code: number, reason: string): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.result.reject(streamCloseError(code, reason));
        this.onClosed();
    }
}

/**
 * Preserves the canonical request/event API while moving Terminal and file bodies onto independent binary sockets.
 */
export class BinaryStreamClient {
    private readonly activeStreams = new Set<TerminalStreamClient | FileStreamClient>();
    private readonly activeRequestIds = new Set<string>();
    private closed = false;
    private readonly terminalOperations = new TerminalOperationQueue();
    private readonly terminals = new Map<string, TerminalStreamClient>();

    constructor(private readonly options: BinaryStreamClientOptions) {}

    private track<T extends TerminalStreamClient | FileStreamClient>(stream: T): void {
        this.activeStreams.add(stream);
    }

    private untrack(stream: TerminalStreamClient | FileStreamClient | undefined): void {
        if (stream) this.activeStreams.delete(stream);
    }

    private async openTerminal(
        operation: Extract<BinaryStreamOperation, { terminalId: string }>,
        id: string,
        lease: TerminalOperationLease,
        input?: Uint8Array,
    ): Promise<TerminalSnapshot | null> {
        const grant = await lease.wait(this.options.issueTicket(id, operation));
        lease.assertActive();
        const holder: { stream?: TerminalStreamClient } = {};
        let opened: Awaited<ReturnType<typeof TerminalStreamClient.open>>;
        try {
            opened = await lease.wait(
                TerminalStreamClient.open(
                    this.options,
                    grant,
                    operation,
                    () => {
                        if (
                            holder.stream &&
                            this.terminals.get(operation.terminalId) === holder.stream
                        )
                            this.terminals.delete(operation.terminalId);
                        this.untrack(holder.stream);
                    },
                    (stream) => {
                        holder.stream = stream;
                        this.track(stream);
                    },
                    input,
                ),
            );
            lease.assertActive();
        } catch (error) {
            holder.stream?.cancel(error);
            throw error;
        }
        if (operation.method === 'terminal.attach')
            this.terminals.set(operation.terminalId, opened.stream);
        return opened.result;
    }

    private async replaceTerminalAttachment(
        operation: Extract<BinaryStreamOperation, { method: 'terminal.attach' }>,
        id: string,
        lease: TerminalOperationLease,
    ): Promise<TerminalSnapshot | null> {
        const previous = this.terminals.get(operation.terminalId);
        if (previous) {
            this.terminals.delete(operation.terminalId);
            await lease.wait(previous.retireAfterPending());
            lease.assertActive();
        }
        if (this.closed)
            throw new CaxriError('UNAVAILABLE', 'Caxri Server binary streams are closed');
        /**
         * A timed-out attachment has already lost its binary output channel. Retry here, where each attempt gets a
         * fresh ticket and stream, rather than retrying only the Host request behind that closed channel. The Server
         * holds output behind the successful snapshot reply, so failed attempts cannot duplicate replay. Keep the
         * existing lease across backoff: detach, terminal close, and disconnect cancel recovery immediately.
         */
        const retryDelays = [250, 1_000];
        let attempt = 0;
        while (true) {
            lease.assertActive();
            try {
                // eslint-disable-next-line no-await-in-loop -- a replacement must wait for the previous stream to fail
                return await this.openTerminal(operation, attempt === 0 ? id : randomUUID(), lease);
            } catch (error) {
                lease.assertActive();
                const delay = retryDelays.at(attempt);
                if (
                    delay === undefined ||
                    !(error instanceof CaxriError) ||
                    (error.code !== 'TIMEOUT' && error.code !== 'UNAVAILABLE')
                )
                    throw error;
                attempt += 1;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    // eslint-disable-next-line no-await-in-loop -- bounded retries must respect cancellable backoff
                    await lease.wait(
                        new Promise<void>((resolve) => {
                            timer = setTimeout(resolve, delay);
                        }),
                    );
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
        }
    }

    private async requestTerminal(id: string, method: CaxriMethod, parameters: unknown) {
        const request = parseCaxriRequest(method, parameters);
        if (request.method === 'terminal.attach')
            return this.terminalOperations.run(request.params.terminalId, (lease) =>
                this.replaceTerminalAttachment(
                    { method: request.method, ...request.params },
                    id,
                    lease,
                ),
            );
        if (request.method === 'terminal.input') {
            const payload = new TextEncoder().encode(request.params.data);
            const terminalId = request.params.terminalId;
            const attached = this.terminals.get(terminalId);
            if (attached && !this.terminalOperations.has(terminalId)) {
                const releasePayload = this.terminalOperations.reserve(payload.byteLength);
                // eslint-disable-next-line unicorn/prefer-await -- the reservation must span the asynchronous acknowledgement
                return attached.input(payload).finally(releasePayload);
            }
            return this.terminalOperations.run(
                terminalId,
                async (lease) => {
                    if (this.closed)
                        throw new CaxriError(
                            'UNAVAILABLE',
                            'Caxri Server binary streams are closed',
                        );
                    const current = this.terminals.get(terminalId);
                    if (current) return lease.wait(current.input(payload));
                    const result = await this.openTerminal(
                        {
                            method: request.method,
                            terminalId,
                            byteLength: payload.byteLength,
                        },
                        id,
                        lease,
                        payload,
                    );
                    if (result !== null)
                        throw new CaxriError('VALIDATION', 'Terminal input returned a snapshot');
                    return result;
                },
                payload.byteLength,
            );
        }
        if (request.method !== 'terminal.resize')
            throw new CaxriError('VALIDATION', `Unsupported Terminal stream method: ${method}`);
        const terminalId = request.params.terminalId;
        const attached = this.terminals.get(terminalId);
        if (attached && !this.terminalOperations.has(terminalId))
            return attached.resize(request.params.cols, request.params.rows);
        return this.terminalOperations.run(terminalId, async (lease) => {
            if (this.closed)
                throw new CaxriError('UNAVAILABLE', 'Caxri Server binary streams are closed');
            const current = this.terminals.get(terminalId);
            if (current)
                return lease.wait(current.resize(request.params.cols, request.params.rows));
            const result = await this.openTerminal(
                { method: request.method, ...request.params },
                id,
                lease,
            );
            if (result !== null)
                throw new CaxriError('VALIDATION', 'Terminal resize returned a snapshot');
            return result;
        });
    }

    private async requestFile(id: string, method: CaxriMethod, parameters: unknown) {
        const request = parseCaxriRequest(method, parameters);
        if (request.method === 'files.read') {
            const operation = { method: request.method, ...request.params };
            const holder: { stream?: FileStreamClient } = {};
            return FileStreamClient.run(
                this.options,
                await this.options.issueTicket(id, operation),
                operation,
                () => this.untrack(holder.stream),
                (stream) => {
                    holder.stream = stream;
                    this.track(stream);
                },
            );
        }
        if (request.method !== 'files.write')
            throw new CaxriError('VALIDATION', `Unsupported file stream method: ${method}`);
        const content = new TextEncoder().encode(request.params.content);
        if (content.byteLength > BINARY_STREAM_MAX_FILE_UPLOAD_BYTES)
            throw new CaxriError('CAPACITY', 'Edited file exceeds the write safety limit');
        const operation = {
            method: request.method,
            sessionId: request.params.sessionId,
            path: request.params.path,
            byteLength: content.byteLength,
        };
        const holder: { stream?: FileStreamClient } = {};
        return FileStreamClient.run(
            this.options,
            await this.options.issueTicket(id, operation),
            operation,
            () => this.untrack(holder.stream),
            (stream) => {
                holder.stream = stream;
                this.track(stream);
            },
            content,
        );
    }

    supports(method: CaxriMethod): boolean {
        return isBinaryStreamMethod(method);
    }

    async request(id: string, method: CaxriMethod, parameters: unknown): Promise<unknown> {
        if (this.closed)
            throw new CaxriError('UNAVAILABLE', 'Caxri Server binary streams are closed');
        if (this.activeRequestIds.has(id))
            throw new CaxriError('CONFLICT', 'Binary stream request ID is already active');
        this.activeRequestIds.add(id);
        try {
            return method.startsWith('terminal.')
                ? await this.requestTerminal(id, method, parameters)
                : await this.requestFile(id, method, parameters);
        } finally {
            this.activeRequestIds.delete(id);
        }
    }

    /**
     * Fences operations that predate a detach request and blocks replacements until the Server has applied that
     * request. Without this cross-transport barrier, a newer binary attachment can reach the Server before the older
     * control detach and then be removed as though it were the attachment that initiated the detach.
     */
    beginTerminalDetach(terminalId: string): TerminalDetachTransition {
        const attachment = this.terminals.get(terminalId);
        this.terminalOperations.invalidate(terminalId);
        const release = this.terminalOperations.block(terminalId);
        let isSettled = false;
        const settle = (shouldRetireAttachment: boolean): void => {
            if (isSettled) return;
            isSettled = true;
            if (
                shouldRetireAttachment &&
                attachment &&
                this.terminals.get(terminalId) === attachment
            ) {
                attachment.retire();
                this.terminals.delete(terminalId);
            }
            release();
        };
        return {
            cancel: () => settle(false),
            complete: () => settle(true),
        };
    }

    closeTerminal(terminalId: string): void {
        this.terminalOperations.invalidate(terminalId);
        this.terminals.get(terminalId)?.retire();
        this.terminals.delete(terminalId);
    }

    close(error = new CaxriError('UNAVAILABLE', 'Caxri Server connection closed')): void {
        if (this.closed) return;
        this.closed = true;
        for (const stream of this.activeStreams) stream.cancel(error);
        this.activeStreams.clear();
        this.terminalOperations.clear();
        this.terminals.clear();
        this.activeRequestIds.clear();
    }
}

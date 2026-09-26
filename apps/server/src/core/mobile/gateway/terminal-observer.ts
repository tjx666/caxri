import { Buffer } from 'node:buffer';

import type { MobileEventPayload, MobileStreamPayload } from '@caxri/mobile-transport';
import { MOBILE_STREAM_CHUNK_MAX_BYTES } from '@caxri/mobile-transport';
import { CaxriError } from '@caxri/protocol';

import type { TerminalExecutionPort, TerminalObserverEvent } from '../../../domains/terminal';
import type { MobileTerminalResyncReason } from './diagnostics';

const LEASE_TIMEOUT_MS = 12_000;
const MAXIMUM_BUFFERED_OUTPUT_BYTES = 640 * 1_024;
type ResyncReason = MobileTerminalResyncReason;

async function ignoreHostTeardown(task: Promise<void>): Promise<void> {
    try {
        await task;
    } catch {
        // A stopped Host has already discarded the observer and lease.
    }
}

interface MobileTerminalObserverOptions {
    authorize: () => Promise<void>;
    holderId: string;
    port: TerminalExecutionPort;
    release: (bytes: number) => void;
    remove: () => void;
    reportResync?: (reason: ResyncReason) => void;
    reserve: (bytes: number) => boolean;
    send: (payload: MobileEventPayload | MobileStreamPayload) => Promise<void>;
    subscriptionId: string;
    terminalId: string;
    terminate: () => void;
}

/**
 * One Host observer and one optional size lease belong to an exact socket subscription.
 */
/* eslint-disable unicorn/consistent-class-member-order -- Public lifecycle methods precede send internals. */
export class MobileTerminalObserver {
    readonly #options: MobileTerminalObserverOptions;
    readonly #pending: Array<{ bytes: number; event: TerminalObserverEvent }> = [];
    readonly #inputControllers = new Set<AbortController>();
    #active = true;
    #activated = false;
    #closePromise?: Promise<void>;
    #generation?: number;
    #hostSequence = 0;
    #leaseGeneration?: number;
    #nextSequence = 0;
    #observed = false;
    #pendingBytes = 0;
    #snapshot: Buffer = Buffer.from('null');
    #snapshotSent = false;
    #sending = false;
    #failureReason?: ResyncReason;

    constructor(options: MobileTerminalObserverOptions) {
        this.#options = options;
    }

    get generation(): number | undefined {
        return this.#generation;
    }

    async start(): Promise<void> {
        const observed = await this.#options.port.observe(
            this.#options.terminalId,
            this.#options.holderId,
        );
        this.#observed = true;
        // close() can run while observe() is pending, despite static narrowing.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- close() may run during observe()
        if (!this.#active) {
            await ignoreHostTeardown(
                this.#options.port.unobserve(this.#options.terminalId, this.#options.holderId),
            );
            return;
        }
        this.#generation = observed.generation;
        this.#hostSequence = observed.nextSequence;
        this.#snapshot = Buffer.from(JSON.stringify(observed.snapshot), 'utf8');
        for (const item of this.#pending) {
            if (!(item.event.sequence < observed.nextSequence)) {
                continue;
            }

            this.#options.release(item.bytes);
            this.#pendingBytes -= item.bytes;
            item.bytes = 0;
        }
        this.#drain();
    }

    accept(event: TerminalObserverEvent): void {
        if (!this.#active || event.terminalId !== this.#options.terminalId) return;
        const bytes =
            event.type === 'output' ? Buffer.byteLength(event.data, 'utf8') * 2 + 256 : 256;
        if (
            this.#pendingBytes + bytes > MAXIMUM_BUFFERED_OUTPUT_BYTES ||
            !this.#options.reserve(bytes)
        ) {
            this.#fail('capacity');
            return;
        }
        this.#pending.push({ event, bytes });
        this.#pendingBytes += bytes;
        this.#drain();
    }

    invalidate(): void {
        this.#fail('generation-changed');
    }

    abortPendingInputs(): void {
        for (const controller of this.#inputControllers) controller.abort();
    }

    activate(): void {
        this.#activated = true;
        this.#drain();
    }

    async close(): Promise<void> {
        if (this.#closePromise) return this.#closePromise;
        this.#active = false;
        this.abortPendingInputs();
        for (const item of this.#pending) this.#options.release(item.bytes);
        this.#pending.length = 0;
        this.#pendingBytes = 0;
        this.#closePromise = (async () => {
            if (this.#leaseGeneration !== undefined) {
                const generation = this.#leaseGeneration;
                this.#leaseGeneration = undefined;
                await ignoreHostTeardown(
                    this.#options.port.releaseTakeOver(
                        this.#options.terminalId,
                        this.#options.holderId,
                        generation,
                    ),
                );
            }
            if (this.#observed)
                await ignoreHostTeardown(
                    this.#options.port.unobserve(this.#options.terminalId, this.#options.holderId),
                );
        })();
        return this.#closePromise;
    }

    async takeOver(
        expectedGeneration: number,
        size: { cols: number; rows: number },
    ): Promise<{ expiresAt: number }> {
        this.#assertGeneration(expectedGeneration);
        await this.#options.authorize();
        this.#assertGeneration(expectedGeneration);
        const result = await this.#options.port.takeOver(
            this.#options.terminalId,
            this.#options.holderId,
            expectedGeneration,
            size,
            LEASE_TIMEOUT_MS,
        );
        if (!this.#active) {
            await this.#options.port.releaseTakeOver(
                this.#options.terminalId,
                this.#options.holderId,
                expectedGeneration,
            );
            throw new CaxriError('CANCELLED', 'Terminal subscription closed');
        }
        this.#leaseGeneration = expectedGeneration;
        return result;
    }

    async releaseTakeOver(expectedGeneration: number): Promise<void> {
        this.#assertGeneration(expectedGeneration);
        if (this.#leaseGeneration !== expectedGeneration)
            throw new CaxriError('CONFLICT', 'Terminal lease is not held by this subscription');
        await this.#options.port.releaseTakeOver(
            this.#options.terminalId,
            this.#options.holderId,
            expectedGeneration,
        );
        this.#leaseGeneration = undefined;
    }

    async input(expectedGeneration: number, data: string): Promise<void> {
        this.#assertGeneration(expectedGeneration);
        const cancellation = new AbortController();
        this.#inputControllers.add(cancellation);
        try {
            await this.#options.authorize();
            this.#assertGeneration(expectedGeneration);
            if (cancellation.signal.aborted)
                throw new CaxriError('CANCELLED', 'Terminal subscription closed');
            if (
                !(await this.#options.port.inputForGeneration(
                    this.#options.terminalId,
                    expectedGeneration,
                    data,
                    cancellation.signal,
                ))
            )
                throw new CaxriError('CONFLICT', 'Terminal generation changed');
        } finally {
            this.#inputControllers.delete(cancellation);
        }
    }

    async renewLease(): Promise<void> {
        const generation = this.#leaseGeneration;
        if (generation === undefined || !this.#active) return;
        try {
            await this.#options.authorize();
            this.#assertGeneration(generation);
            await this.#options.port.renewTakeOver(
                this.#options.terminalId,
                this.#options.holderId,
                generation,
                LEASE_TIMEOUT_MS,
            );
        } catch {
            this.#fail('generation-changed');
        }
    }

    #assertGeneration(expectedGeneration: number): void {
        if (!this.#active || this.#generation !== expectedGeneration)
            throw new CaxriError('CONFLICT', 'Terminal generation changed');
    }

    #fail(reason: ResyncReason): void {
        if (this.#failureReason || !this.#active) return;
        this.#failureReason = reason;
        this.abortPendingInputs();
        this.#drain();
    }

    #drain(): void {
        if (!this.#activated || !this.#observed || this.#sending || !this.#active) return;
        this.#sending = true;
        // eslint-disable-next-line no-void -- The observer owns its independent bounded output task.
        void this.#run().finally(() => {
            this.#sending = false;
            if (
                this.#active &&
                (!this.#snapshotSent || this.#pending.length > 0 || this.#failureReason)
            )
                this.#drain();
        });
    }

    async #run(): Promise<void> {
        try {
            if (this.#failureReason) return await this.#resync(this.#failureReason);
            const generation = this.#generation!;
            if (!this.#snapshotSent) {
                const chunks = Math.max(
                    1,
                    Math.ceil(this.#snapshot.length / MOBILE_STREAM_CHUNK_MAX_BYTES),
                );
                if (!(await this.#sendSnapshotChunk(generation, 0, chunks))) return;
                this.#snapshotSent = true;
                this.#snapshot = Buffer.alloc(0);
            }
            await this.#sendNextOutput(generation);
        } catch {
            this.#options.remove();
            this.#options.terminate();
            await this.close();
        }
    }

    async #sendSnapshotChunk(generation: number, index: number, count: number): Promise<boolean> {
        if (!this.#active) return false;
        if (this.#failureReason) {
            await this.#resync(this.#failureReason);
            return false;
        }
        await this.#options.authorize();
        await this.#options.send({
            type: 'stream',
            kind: 'terminal.snapshot',
            subscriptionId: this.#options.subscriptionId,
            sequence: this.#nextSequence++,
            generation,
            nextHostSequence: this.#hostSequence,
            chunkIndex: index,
            chunkCount: count,
            chunkHex: this.#snapshot
                .subarray(
                    index * MOBILE_STREAM_CHUNK_MAX_BYTES,
                    (index + 1) * MOBILE_STREAM_CHUNK_MAX_BYTES,
                )
                .toString('hex'),
        });
        return index + 1 === count || this.#sendSnapshotChunk(generation, index + 1, count);
    }

    async #sendNextOutput(generation: number): Promise<void> {
        if (!this.#active) return;
        if (this.#failureReason) return this.#resync(this.#failureReason);
        const item = this.#pending.shift();
        if (!item) return;
        try {
            const event = item.event;
            if (event.sequence >= this.#hostSequence) {
                if (event.generation !== generation)
                    return await this.#resync('generation-changed');
                if (event.sequence !== this.#hostSequence) return await this.#resync('source-gap');
                if (event.type === 'gap')
                    return event.reason === 'resize'
                        ? await this.#refreshSnapshot()
                        : await this.#resync('source-gap');
                this.#hostSequence += 1;
                const bytes = Buffer.from(event.data, 'utf8');
                const count = Math.max(1, Math.ceil(bytes.length / MOBILE_STREAM_CHUNK_MAX_BYTES));
                if (!(await this.#sendOutputChunk(generation, event.sequence, bytes, 0, count)))
                    return;
            }
        } finally {
            this.#options.release(item.bytes);
            this.#pendingBytes -= item.bytes;
        }
        return this.#sendNextOutput(generation);
    }

    async #sendOutputChunk(
        generation: number,
        hostSequence: number,
        bytes: Buffer,
        index: number,
        count: number,
    ): Promise<boolean> {
        if (!this.#active) return false;
        if (this.#failureReason) {
            await this.#resync(this.#failureReason);
            return false;
        }
        await this.#options.authorize();
        await this.#options.send({
            type: 'stream',
            kind: 'terminal.output',
            subscriptionId: this.#options.subscriptionId,
            sequence: this.#nextSequence++,
            generation,
            hostSequence,
            chunkIndex: index,
            chunkCount: count,
            chunkHex: bytes
                .subarray(
                    index * MOBILE_STREAM_CHUNK_MAX_BYTES,
                    (index + 1) * MOBILE_STREAM_CHUNK_MAX_BYTES,
                )
                .toString('hex'),
        });
        return (
            index + 1 === count ||
            this.#sendOutputChunk(generation, hostSequence, bytes, index + 1, count)
        );
    }

    async #resync(reason: ResyncReason): Promise<void> {
        if (!this.#active) return;
        try {
            await this.#options.authorize();
            await this.#options.send({
                type: 'event',
                kind: 'resync-required',
                reason,
                subscriptionId: this.#options.subscriptionId,
                sequence: this.#nextSequence++,
            });
            this.#options.reportResync?.(reason);
        } finally {
            this.#options.remove();
            await this.close();
        }
    }

    /**
     * A grid reshape replaces the snapshot on this subscription, preserving its size lease.
     */
    async #refreshSnapshot(): Promise<void> {
        if (!this.#active) return;
        await this.#options.authorize();
        for (const item of this.#pending) {
            this.#options.release(item.bytes);
            this.#pendingBytes -= item.bytes;
        }
        this.#pending.length = 0;
        await this.#options.port.unobserve(this.#options.terminalId, this.#options.holderId);
        this.#observed = false;
        const observed = await this.#options.port.observe(
            this.#options.terminalId,
            this.#options.holderId,
        );
        this.#observed = true;
        // close() can run while observe() is pending, despite static narrowing.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- close() may run during observe()
        if (!this.#active) {
            await ignoreHostTeardown(
                this.#options.port.unobserve(this.#options.terminalId, this.#options.holderId),
            );
            this.#observed = false;
            return;
        }
        if (observed.generation !== this.#generation) return this.#resync('generation-changed');
        this.#hostSequence = observed.nextSequence;
        this.#snapshot = Buffer.from(JSON.stringify(observed.snapshot), 'utf8');
        this.#snapshotSent = false;
        this.#options.reportResync?.('resize');
    }
}
/* eslint-enable unicorn/consistent-class-member-order */

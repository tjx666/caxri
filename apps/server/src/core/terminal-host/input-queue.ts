import { MAX_TERMINAL_INPUT_LENGTH } from '@caxri/protocol';

interface TerminalInputChunk {
    data: string;
    receipt?: TerminalInputReceipt;
}

export interface TerminalInputBatch {
    chunks: TerminalInputChunk[];
    data: string;
    length: number;
}

export interface TerminalInputReceipt {
    completion: PromiseWithResolvers<void>;
    remainingChunks: number;
}

/**
 * Splits one public input before queue admission so every private request passes its own schema. A UTF-16 high
 * surrogate moves to the next chunk with its low surrogate because encoding either half independently would replace the
 * user's character.
 */
function splitTerminalInput(data: string): string[] {
    const chunks: string[] = [];
    for (let offset = 0; offset < data.length;) {
        let end = Math.min(data.length, offset + MAX_TERMINAL_INPUT_LENGTH);
        const boundary = data.codePointAt(end - 1);
        if (boundary !== undefined && boundary >= 0x1_0000 && end < data.length) end -= 1;
        chunks.push(data.slice(offset, end));
        offset = end;
    }
    return chunks;
}

/**
 * Owns bounded private chunks and per-public-input acknowledgements for one Terminal attachment.
 */
export class TerminalInputQueue<Identity> {
    private activeBatch?: TerminalInputBatch;
    private chunks: TerminalInputChunk[] = [];
    private deferredRejection?: unknown;
    private head = 0;
    private readonly receipts = new Set<TerminalInputReceipt>();
    readonly abortController = new AbortController();
    completion?: Promise<void>;
    queuedCharacters = 0;

    constructor(
        readonly attachmentId: string,
        readonly identity: Identity,
    ) {}

    private acknowledgeReceipt(receipt: TerminalInputReceipt): void {
        receipt.remainingChunks -= 1;
        if (receipt.remainingChunks > 0) return;
        this.receipts.delete(receipt);
        receipt.completion.resolve();
    }

    private compact(): void {
        if (this.head === this.chunks.length) {
            this.chunks = [];
            this.head = 0;
        } else if (this.head >= 1_024) {
            this.chunks = this.chunks.slice(this.head);
            this.head = 0;
        }
    }

    get hasAcknowledgedInput(): boolean {
        return this.receipts.size > 0;
    }

    get hasPendingChunks(): boolean {
        return this.head < this.chunks.length;
    }

    settleAcceptedBatch(batch: TerminalInputBatch): boolean {
        if (this.activeBatch !== batch) return true;
        this.activeBatch = undefined;
        this.queuedCharacters -= batch.length;
        for (const chunk of batch.chunks) {
            const receipt = chunk.receipt;
            if (receipt) this.acknowledgeReceipt(receipt);
        }
        this.compact();
        if (this.deferredRejection === undefined) return false;
        const error = this.deferredRejection;
        this.deferredRejection = undefined;
        this.reject(error);
        return true;
    }

    enqueue(data: string, shouldAcknowledge: boolean): TerminalInputReceipt | undefined {
        const chunks = splitTerminalInput(data);
        const receipt = shouldAcknowledge
            ? { completion: Promise.withResolvers<void>(), remainingChunks: chunks.length }
            : undefined;
        if (receipt) this.receipts.add(receipt);
        this.chunks.push(...chunks.map((chunk) => ({ data: chunk, ...(receipt && { receipt }) })));
        this.queuedCharacters += data.length;
        return receipt;
    }

    hasReceipt(receipt: TerminalInputReceipt): boolean {
        return this.receipts.has(receipt);
    }

    /**
     * Keeps an accepted private write alive when its PTY exit event overtakes the reply. The reply still proves whether
     * that active batch was delivered; all later queued input remains rejected against the retired Terminal.
     */
    deferRejectionUntilActiveBatchSettles(error: unknown): boolean {
        if (!this.activeBatch) return false;
        this.deferredRejection = error;
        return true;
    }

    reject(error: unknown): void {
        this.abortController.abort();
        this.activeBatch = undefined;
        this.deferredRejection = undefined;
        for (const receipt of this.receipts) receipt.completion.reject(error);
        this.receipts.clear();
    }

    takeBatch(): TerminalInputBatch {
        const chunks: TerminalInputChunk[] = [];
        let length = 0;
        while (this.head < this.chunks.length) {
            const chunk = this.chunks[this.head];
            if (length > 0 && length + chunk.data.length > MAX_TERMINAL_INPUT_LENGTH) break;
            this.head += 1;
            chunks.push(chunk);
            length += chunk.data.length;
        }
        const batch = { chunks, data: chunks.map(({ data }) => data).join(''), length };
        this.activeBatch = batch;
        return batch;
    }
}

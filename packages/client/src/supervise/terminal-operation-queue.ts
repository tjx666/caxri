import { BINARY_STREAM_MAX_BUFFERED_BYTES, CaxriError } from '@caxri/protocol';

export interface TerminalOperationLease {
    assertActive(): void;
    wait<Result>(operation: Promise<Result>): Promise<Result>;
}

interface TerminalOperationToken {
    readonly cancelled: PromiseWithResolvers<void>;
    readonly error: CaxriError;
}

/**
 * Serializes lifecycle operations only while a Terminal has no stable persistent stream. Invalidating a Terminal
 * detaches new work from an old promise tail and makes every suspended operation fail before it can publish stale
 * state. Failures remain visible to their caller but never poison later operations for the same Terminal.
 */
export class TerminalOperationQueue {
    private queuedPayloadBytes = 0;
    private readonly tails = new Map<string, { barrier: Promise<void> }>();
    private readonly tokens = new Map<string, TerminalOperationToken>();

    private tokenFor(terminalId: string): TerminalOperationToken {
        const current = this.tokens.get(terminalId);
        if (current) return current;
        const token = {
            cancelled: Promise.withResolvers<void>(),
            error: new CaxriError('CANCELLED', 'Terminal stream operation was cancelled'),
        };
        this.tokens.set(terminalId, token);
        return token;
    }

    has(terminalId: string): boolean {
        return this.tails.has(terminalId);
    }

    run<Result>(
        terminalId: string,
        action: (lease: TerminalOperationLease) => Promise<Result>,
        retainedPayloadBytes = 0,
    ): Promise<Result> {
        if (
            retainedPayloadBytes < 0 ||
            !Number.isSafeInteger(retainedPayloadBytes) ||
            this.queuedPayloadBytes + retainedPayloadBytes > BINARY_STREAM_MAX_BUFFERED_BYTES
        )
            return Promise.reject(
                new CaxriError('CAPACITY', 'Terminal operation queue exceeded its byte budget'),
            );
        this.queuedPayloadBytes += retainedPayloadBytes;
        const token = this.tokenFor(terminalId);
        const assertActive = (): void => {
            if (this.tokens.get(terminalId) !== token) throw token.error;
        };
        const cancellation = async (): Promise<never> => {
            await token.cancelled.promise;
            throw token.error;
        };
        const wait = async <Value>(operation: Promise<Value>): Promise<Value> =>
            Promise.race([operation, cancellation()]);
        const previous = this.tails.get(terminalId)?.barrier ?? Promise.resolve();
        const scheduled = (async (): Promise<Result> => {
            await wait(previous);
            assertActive();
            const result = await action({ assertActive, wait });
            assertActive();
            return result;
        })();
        const entry = { barrier: Promise.resolve() };
        entry.barrier = (async (): Promise<void> => {
            try {
                await scheduled;
            } catch {
                // The caller retains the failure while the queue remains usable for later operations.
            } finally {
                this.queuedPayloadBytes -= retainedPayloadBytes;
                if (this.tails.get(terminalId) === entry) {
                    this.tails.delete(terminalId);
                    if (this.tokens.get(terminalId) === token) this.tokens.delete(terminalId);
                }
            }
        })();
        this.tails.set(terminalId, entry);
        return scheduled;
    }

    invalidate(terminalId: string): void {
        this.tokens.get(terminalId)?.cancelled.resolve();
        this.tokens.delete(terminalId);
        this.tails.delete(terminalId);
    }

    clear(): void {
        for (const token of this.tokens.values()) token.cancelled.resolve();
        this.tokens.clear();
        this.tails.clear();
    }
}

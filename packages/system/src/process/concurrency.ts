/**
 * Maps in input order while allowing at most `maximum` asynchronous operations to run at once.
 */
export async function mapWithConcurrency<Input, Output>(
    inputs: readonly Input[],
    maximum: number,
    map: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
    if (inputs.length === 0) return [];
    const results: Output[] = Array.from({ length: inputs.length });
    let isFailed = false;
    let failure: unknown;
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        if (isFailed) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= inputs.length) return;
        try {
            results[index] = await map(inputs[index], index);
        } catch (error) {
            /**
             * Stop claiming queued work, but drain already-started workers before rejecting.
             */
            // The type-aware checker narrows `isFailed` from the `if (isFailed) return;` guard above
            // and does not account for concurrent `worker()` calls reassigning it during the awaited
            // `map()` call (`tsc --strict` correctly widens this to `boolean`); keep the check so a
            // second worker's failure never clobbers the first recorded `failure`.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- isFailed can be set by a concurrent worker during the preceding await; checker narrowing is a false positive
            if (!isFailed) {
                isFailed = true;
                failure = error;
            }
            return;
        }
        return worker();
    };
    const workerCount = Math.min(inputs.length, Math.max(1, maximum));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- isFailed can be set by any concurrent worker; checker narrowing is a false positive, see comment above
    if (isFailed) throw failure;
    return results;
}

/**
 * Lets one consumer cancel its wait without aborting an operation that may be shared with other consumers.
 */
export async function waitForSharedOperation<Value>(
    operation: Promise<Value>,
    signal: AbortSignal | undefined,
    cancellationError: () => Error,
): Promise<Value> {
    if (!signal) return operation;
    if (signal.aborted) throw cancellationError();
    let cancel = (): void => {};
    const cancellation = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(cancellationError());
        signal.addEventListener('abort', cancel, { once: true });
    });
    try {
        return await Promise.race([operation, cancellation]);
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}

/**
 * FIFO semaphore for native subprocess and file-descriptor budgets shared by concurrent requests.
 */
export class AsyncSemaphore {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly maximum: number) {
        if (!Number.isSafeInteger(maximum) || maximum < 1)
            throw new RangeError('Semaphore capacity must be a positive integer');
    }

    private acquire(): Promise<void> {
        if (this.active < this.maximum) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.waiting.push(() => {
                this.active += 1;
                resolve();
            });
        });
    }

    private release(): void {
        this.active -= 1;
        this.waiting.shift()?.();
    }

    async run<Value>(operation: () => Promise<Value>): Promise<Value> {
        await this.acquire();
        try {
            return await operation();
        } finally {
            this.release();
        }
    }
}

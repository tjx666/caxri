/** Maps in input order while allowing at most `maximum` asynchronous operations to run at once. */
export async function mapWithConcurrency<Input, Output>(
    inputs: readonly Input[],
    maximum: number,
    map: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
    if (inputs.length === 0) return [];
    const results = new Array<Output>(inputs.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= inputs.length) return;
        results[index] = await map(inputs[index], index);
        return worker();
    };
    await Promise.all(
        Array.from({ length: Math.min(inputs.length, Math.max(1, maximum)) }, () => worker()),
    );
    return results;
}

/** FIFO semaphore for native subprocess and file-descriptor budgets shared by concurrent requests. */
export class AsyncSemaphore {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly maximum: number) {
        if (!Number.isInteger(maximum) || maximum < 1)
            throw new RangeError('Semaphore capacity must be a positive integer');
    }

    async run<Value>(operation: () => Promise<Value>): Promise<Value> {
        await this.acquire();
        try {
            return await operation();
        } finally {
            this.release();
        }
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
}

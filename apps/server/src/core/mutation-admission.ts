import { CaxriError } from '@caxri/protocol';

/**
 * Tracks in-flight mutations so shutdown can close admission and drain safely.
 */
export class MutationAdmission {
    readonly #drainWaiters = new Set<() => void>();
    #inFlight = 0;
    #isClosed = false;

    get isClosed(): boolean {
        return this.#isClosed;
    }

    begin(): void {
        if (this.#isClosed) throw new CaxriError('UNAVAILABLE', 'Host is stopping');
        this.#inFlight += 1;
    }

    close(): void {
        this.#isClosed = true;
    }

    finish(): void {
        this.#inFlight -= 1;
        if (this.#inFlight !== 0) return;
        for (const resolve of this.#drainWaiters) resolve();
        this.#drainWaiters.clear();
    }

    reopen(): void {
        this.#isClosed = false;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        this.begin();
        try {
            return await task();
        } finally {
            this.finish();
        }
    }

    waitForDrain(): Promise<void> {
        return this.#inFlight === 0
            ? Promise.resolve()
            : new Promise((resolve) => this.#drainWaiters.add(resolve));
    }
}

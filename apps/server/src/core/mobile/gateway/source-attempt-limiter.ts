export const MAXIMUM_SOURCE_ATTEMPTS = 10;
export const SOURCE_ATTEMPT_WINDOW_MS = 60_000;
/**
 * Distinct remote addresses remembered at once. The per-source window already bounds retries; this bound stops the map
 * itself from growing for the lifetime of a Server process.
 */
export const MAXIMUM_SOURCE_ATTEMPT_KEYS = 256;

interface SourceAttempt {
    count: number;
    startedAt: number;
}

/**
 * Rolling per-source admission window for the mobile LAN gateway. Expired entries are pruned on admit, a refreshed
 * window is reinserted so JavaScript Map order stays FIFO, and disable/close drops the table instead of leaking it.
 */
export class SourceAttemptLimiter {
    readonly #attempts = new Map<string, SourceAttempt>();
    readonly #now: () => number;

    constructor(options: { now: () => number }) {
        this.#now = options.now;
    }

    get size(): number {
        return this.#attempts.size;
    }

    admit(source: string): boolean {
        const now = this.#now();
        for (const [key, attempt] of this.#attempts)
            if (now - attempt.startedAt >= SOURCE_ATTEMPT_WINDOW_MS) this.#attempts.delete(key);

        const current = this.#attempts.get(source);
        if (current) {
            current.count += 1;
            return current.count <= MAXIMUM_SOURCE_ATTEMPTS;
        }
        if (this.#attempts.size >= MAXIMUM_SOURCE_ATTEMPT_KEYS) {
            const oldest = this.#attempts.keys().next().value;
            if (oldest !== undefined) this.#attempts.delete(oldest);
        }
        this.#attempts.set(source, { count: 1, startedAt: now });
        return true;
    }

    clear(): void {
        this.#attempts.clear();
    }
}

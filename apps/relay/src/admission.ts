import type { IncomingMessage } from 'node:http';

const WINDOW_MS = 60_000;

/**
 * Pre-authentication budget per source address: a sliding one-minute attempt window plus a cap on sockets that have not
 * yet proved anything. Authenticated sockets release their pending slot, so a busy host is never throttled by its own
 * established connections.
 */
export class SourceAdmission {
    readonly #attempts = new Map<string, number[]>();
    readonly #pending = new Map<string, number>();
    readonly #attemptsPerMinute: number;
    readonly #pendingLimit: number;
    readonly #now: () => number;

    constructor(options: { attemptsPerMinute: number; pendingLimit: number; now?: () => number }) {
        this.#attemptsPerMinute = options.attemptsPerMinute;
        this.#pendingLimit = options.pendingLimit;
        this.#now = options.now ?? Date.now;
    }

    /**
     * Records one attempt and reports why it is refused, or `undefined` when admitted. An admitted attempt holds a
     * pending slot until `release` runs.
     */
    admit(
        source: string,
        shouldCountAttempt: boolean,
    ): 'rate-limited' | 'source-pending' | undefined {
        const now = this.#now();
        if (shouldCountAttempt) {
            const recent = (this.#attempts.get(source) ?? []).filter(
                (time) => now - time < WINDOW_MS,
            );
            if (recent.length >= this.#attemptsPerMinute) {
                this.#attempts.set(source, recent);
                return 'rate-limited';
            }
            recent.push(now);
            this.#attempts.set(source, recent);
        }
        const pending = this.#pending.get(source) ?? 0;
        if (pending >= this.#pendingLimit) return 'source-pending';
        this.#pending.set(source, pending + 1);
        return undefined;
    }

    release(source: string): void {
        const pending = (this.#pending.get(source) ?? 1) - 1;
        if (pending <= 0) this.#pending.delete(source);
        else this.#pending.set(source, pending);
    }

    /**
     * Drops attempt windows that aged out so idle sources do not accumulate.
     */
    sweep(): void {
        const now = this.#now();
        for (const [source, times] of this.#attempts) {
            const recent = times.filter((time) => now - time < WINDOW_MS);
            if (recent.length === 0) this.#attempts.delete(source);
            else this.#attempts.set(source, recent);
        }
    }
}

/**
 * The address used only for rate limiting; it is never logged.
 */
export const sourceAddress = (request: IncomingMessage, isProxyTrusted: boolean): string => {
    if (isProxyTrusted) {
        const forwarded = request.headers['x-forwarded-for'];
        const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
            ?.split(',', 1)[0]
            ?.trim();
        if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown';
};

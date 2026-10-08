/**
 * Smallest cache that makes live preview affordable.
 *
 * Every keystroke in the source editor re-renders the whole document, and both expensive per-block steps (Monaco
 * colorization and Mermaid layout) depend only on the block's own text. Memoizing them by that text turns a re-render
 * into a map lookup for every block the edit did not touch. Insertion order doubles as recency because a re-render
 * re-reads each surviving key, so evicting the oldest entry drops what the document stopped referring to.
 */
export class PreviewMemoCache<T> {
    readonly #entries = new Map<string, T>();
    readonly #capacity: number;

    constructor(capacity: number) {
        this.#capacity = capacity;
    }

    get(key: string): T | undefined {
        const value = this.#entries.get(key);
        if (value === undefined) return undefined;
        this.#entries.delete(key);
        this.#entries.set(key, value);
        return value;
    }

    set(key: string, value: T): void {
        this.#entries.delete(key);
        this.#entries.set(key, value);
        while (this.#entries.size > this.#capacity) {
            const oldest = this.#entries.keys().next();
            if (oldest.done) return;
            this.#entries.delete(oldest.value);
        }
    }

    clear(): void {
        this.#entries.clear();
    }

    get size(): number {
        return this.#entries.size;
    }
}

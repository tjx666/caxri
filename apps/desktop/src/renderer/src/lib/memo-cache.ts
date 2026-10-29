/**
 * Smallest LRU cache for per-block render work (Monaco colorization, Mermaid layout).
 *
 * A live Markdown preview re-renders the whole document on every keystroke and a streaming Chat reply on every delta,
 * while both expensive per-block steps (Monaco colorization and Mermaid layout) depend only on the block's own text.
 * Memoizing them by that text turns a re-render into a map lookup for every block the edit did not touch. Insertion
 * order doubles as recency because a re-render re-reads each surviving key, so evicting the oldest entry drops what the
 * document stopped referring to.
 *
 * Besides its entry count, the cache is bounded by the characters its keys and values hold together: the key carries
 * the block's whole source and the value its rendered markup, so a few long blocks would otherwise pin megabytes that
 * an entry count never notices. An entry larger than the whole budget is not stored. PandaCode bounds its formatted
 * Markdown cache the same way (`.agents/skills/competitors/references/pandacode.md`).
 */
export class MemoCache {
    readonly #entries = new Map<string, string>();
    readonly #capacity: number;
    readonly #maxCharacters: number;
    #characters = 0;

    constructor(capacity: number, maxCharacters: number) {
        this.#capacity = capacity;
        this.#maxCharacters = maxCharacters;
    }

    #delete(key: string): void {
        const value = this.#entries.get(key);
        if (value === undefined) return;
        this.#entries.delete(key);
        this.#characters -= key.length + value.length;
    }

    get(key: string): string | undefined {
        const value = this.#entries.get(key);
        if (value === undefined) return undefined;
        this.#entries.delete(key);
        this.#entries.set(key, value);
        return value;
    }

    set(key: string, value: string): void {
        this.#delete(key);
        const characters = key.length + value.length;
        if (characters > this.#maxCharacters) return;
        this.#entries.set(key, value);
        this.#characters += characters;
        while (this.#entries.size > this.#capacity || this.#characters > this.#maxCharacters) {
            const oldest = this.#entries.keys().next();
            if (oldest.done) return;
            this.#delete(oldest.value);
        }
    }

    clear(): void {
        this.#entries.clear();
        this.#characters = 0;
    }

    get size(): number {
        return this.#entries.size;
    }

    /**
     * Characters held by every key and value together.
     */
    get characters(): number {
        return this.#characters;
    }
}

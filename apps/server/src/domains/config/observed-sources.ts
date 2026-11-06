import { ConfigSourceReadError } from './source';

/**
 * What the configuration service last saw on disk for each config file path, plus the revision bookkeeping that keeps
 * slow or failing reads from overwriting newer state.
 */
export class ObservedConfigSources {
    readonly #sources = new Map<string, string>();
    /**
     * Bumped on every {@link set}, so an external read can tell it was overtaken while awaiting the file: a Settings
     * update or a newer read that landed meanwhile owns the current state, and the slower read must not roll it back or
     * emit a second change (caxri#3492).
     */
    readonly #revisions = new Map<string, number>();
    /**
     * Paths with a Settings update writing to disk. An external read that settles while one is pending may have seen
     * the new bytes before the update recorded them, so it must not apply or announce them a second time (caxri#3490).
     */
    readonly #pendingWrites = new Map<string, number>();
    readonly #rejectedRevisions = new Map<string, string>();

    get(path: string): string | undefined {
        return this.#sources.get(path);
    }

    set(path: string, source: string): void {
        this.#sources.set(path, source);
        this.#revisions.set(path, this.revision(path) + 1);
    }

    /**
     * Runs an update's disk write and records its source as observed, all while the path is marked as writing. A read
     * that settles meanwhile is dropped by {@link isOvertaken} instead of applying and announcing the new bytes before
     * the update does (caxri#3490).
     */
    async trackWrite(
        path: string,
        source: string,
        write: (path: string, source: string) => Promise<void>,
    ): Promise<void> {
        this.#pendingWrites.set(path, (this.#pendingWrites.get(path) ?? 0) + 1);
        this.#revisions.set(path, this.revision(path) + 1);
        try {
            await write(path, source);
            this.set(path, source);
        } finally {
            const remaining = (this.#pendingWrites.get(path) ?? 1) - 1;
            if (remaining > 0) this.#pendingWrites.set(path, remaining);
            else this.#pendingWrites.delete(path);
        }
    }

    /**
     * Whether a read that captured `revision` before awaiting the file was overtaken by a write or a newer state.
     */
    isOvertaken(path: string, revision: number): boolean {
        return this.#pendingWrites.has(path) || this.revision(path) !== revision;
    }

    revision(path: string): number {
        return this.#revisions.get(path) ?? 0;
    }

    forgetRejected(path: string): void {
        this.#rejectedRevisions.delete(path);
    }

    /**
     * Suppresses repeated polling errors without retaining any rejected source bytes. Returns whether the same rejected
     * revision was already reported.
     */
    rememberRejected(path: string, error: unknown): boolean {
        if (!(error instanceof ConfigSourceReadError)) {
            this.#rejectedRevisions.delete(path);
            return false;
        }
        const isRepeated = this.#rejectedRevisions.get(path) === error.revision;
        this.#rejectedRevisions.set(path, error.revision);
        return isRepeated;
    }
}

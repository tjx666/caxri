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
    readonly #rejectedRevisions = new Map<string, string>();

    get(path: string): string | undefined {
        return this.#sources.get(path);
    }

    set(path: string, source: string): void {
        this.#sources.set(path, source);
        this.#revisions.set(path, this.revision(path) + 1);
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

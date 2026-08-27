import process from 'node:process';

export interface ServerBuildWatcher {
    close(): Promise<void>;
}

interface ArtifactRefreshCoordinatorOptions {
    refreshArtifact: () => Promise<void>;
    reportReady: () => Promise<void>;
    watcher: ServerBuildWatcher;
}

export class ArtifactRefreshCoordinator {
    readonly #refreshArtifact: () => Promise<void>;
    readonly #reportReady: () => Promise<void>;
    readonly #watcher: ServerBuildWatcher;
    #hasReportedReady = false;
    #isClosing = false;
    #isRefreshing = false;
    #needsRefresh = false;

    constructor(options: ArtifactRefreshCoordinatorOptions) {
        this.#refreshArtifact = options.refreshArtifact;
        this.#reportReady = options.reportReady;
        this.#watcher = options.watcher;
    }

    #hasPendingRefresh(): boolean {
        return this.#needsRefresh;
    }

    async close(exitCode: number): Promise<void> {
        if (this.#isClosing) return;
        this.#isClosing = true;
        this.#needsRefresh = false;
        await this.#watcher.close();
        process.exitCode = exitCode;
    }

    async refresh(): Promise<void> {
        this.#needsRefresh = true;
        if (this.#isRefreshing || this.#isClosing) return;
        this.#isRefreshing = true;
        try {
            do {
                while (this.#needsRefresh) {
                    this.#needsRefresh = false;
                    // eslint-disable-next-line no-await-in-loop -- coalesced rebuilds must publish artifacts in source order
                    await this.#refreshArtifact();
                }
                if (!this.#hasReportedReady) {
                    // eslint-disable-next-line no-await-in-loop -- readiness publication is part of the dirty-flag loop
                    await this.#reportReady();
                    this.#hasReportedReady = true;
                }
                /**
                 * `reportReady` writes a file and therefore yields. Recheck the dirty flag afterward so an END event
                 * received during that write cannot be stranded until the next source edit.
                 */
            } while (this.#hasPendingRefresh());
        } finally {
            this.#isRefreshing = false;
        }
    }
}

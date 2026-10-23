import type { CancellationTokenSource } from 'caxri';

export interface DetailTask {
    cancellation: CancellationTokenSource;
    run: () => Promise<void>;
}

const MAX_CONCURRENT_DETAIL_REQUESTS = 4;

/**
 * Bounded queue for the provider's per-repository detail lookups (commit details, pull request changes), so a
 * multi-repository scope never floods the Server with parallel Git or GitHub requests.
 */
export class DetailQueue {
    private activeRequests = 0;
    private readonly slotWaiters: Array<() => void> = [];
    private readonly tasks = new Set<DetailTask>();

    private async acquireSlot(): Promise<void> {
        if (this.activeRequests < MAX_CONCURRENT_DETAIL_REQUESTS) {
            this.activeRequests += 1;
            return;
        }
        await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }

    private releaseSlot(): void {
        const next = this.slotWaiters.shift();
        if (next) next();
        else this.activeRequests -= 1;
    }

    enqueue(task: DetailTask): void {
        this.tasks.add(task);
        /**
         * Start the async wrapper in the originating provider call's AsyncLocalStorage context. Deferring `task.run`
         * from a previous scope's completion callback would bind its authorized workspace requests to that scope.
         */
        void (async () => {
            await this.acquireSlot();
            try {
                if (!task.cancellation.token.isCancellationRequested) await task.run();
            } finally {
                this.tasks.delete(task);
                this.releaseSlot();
            }
        })();
    }

    dispose(): void {
        for (const task of this.tasks) {
            task.cancellation.cancel();
            task.cancellation.dispose();
        }
        this.tasks.clear();
    }
}

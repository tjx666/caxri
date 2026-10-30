interface BestEffortTeardown {
    attempt: (...actions: Array<() => unknown>) => Promise<void>;
    /**
     * Attempts `close()` on each service in order.
     */
    closeEach: (...services: Array<{ close(): unknown }>) => Promise<void>;
    /**
     * Number of failures collected so far.
     */
    failureCount: () => number;
    rethrow: () => void;
}

/**
 * Collects teardown failures so every closer is attempted. One failing closer must not skip the closers after it (the
 * Terminal orderly snapshot, the database last); `rethrow` then reports every failure together.
 */
export function createBestEffortTeardown(): BestEffortTeardown {
    const failures: unknown[] = [];
    const teardown: BestEffortTeardown = {
        async attempt(...actions) {
            for (const action of actions) {
                try {
                    // eslint-disable-next-line no-await-in-loop -- closers run in order
                    await action();
                } catch (error) {
                    failures.push(error);
                }
            }
        },
        closeEach: (...services) =>
            teardown.attempt(...services.map((service) => () => service.close())),
        failureCount: () => failures.length,
        rethrow() {
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(failures, `${failures.length} teardown steps failed`);
        },
    };
    return teardown;
}

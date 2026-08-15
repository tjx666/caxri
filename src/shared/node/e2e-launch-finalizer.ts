export interface E2ELaunchFinalizer {
    begin: () => Promise<void>;
    finish: (close: () => Promise<void>) => Promise<void>;
}

/**
Starts launch cleanup exactly once and makes fixture teardown wait for it before reporting.
 */
export function createE2ELaunchFinalizer(cleanup: () => Promise<void>): E2ELaunchFinalizer {
    let cleanupPromise: Promise<void> | undefined;
    const begin = (): Promise<void> => (cleanupPromise ??= cleanup());
    return {
        begin,
        finish: async (close) => {
            try {
                if (!cleanupPromise) await close();
            } finally {
                await begin();
            }
        },
    };
}

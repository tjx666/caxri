interface WindowCloseOptions {
    close: () => void;
    confirm: (runningCount: number) => Promise<'cancel' | 'close' | 'terminate'>;
    countRunning: () => Promise<number>;
    logFailure: (message: string) => void;
    terminateAll: () => Promise<void>;
}

/** Completes window closure even when the Runtime is unavailable during shutdown. */
export async function resolveWindowClose(options: WindowCloseOptions): Promise<void> {
    try {
        const runningCount = await options.countRunning();
        if (runningCount > 0) {
            const decision = await options.confirm(runningCount);
            if (decision === 'cancel') return;
            if (decision === 'terminate') await options.terminateAll();
        }
    } catch (error) {
        options.logFailure(error instanceof Error ? error.message : 'Unknown close failure');
    }
    options.close();
}

export function createWindowCloseHandler(options: WindowCloseOptions): () => Promise<void> {
    let pending: Promise<void> | undefined;
    return () => {
        pending ??= resolveWindowClose(options).finally(() => {
            pending = undefined;
        });
        return pending;
    };
}

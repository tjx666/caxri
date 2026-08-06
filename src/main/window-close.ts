import { errorMessage } from '../shared/ipc/errors';

interface WindowCloseOptions {
    close: () => void;
    confirm: (runningCount: number) => Promise<'cancel' | 'close' | 'terminate'>;
    countRunning: () => Promise<number>;
    /** Runtime replies carry a result the close flow ignores; only rejection matters here. */
    detachAll: () => Promise<unknown>;
    logFailure: (message: string) => void;
    terminateAll: () => Promise<unknown>;
}

/** Completes window closure even when the Runtime is unavailable during shutdown. */
export async function resolveWindowClose(options: WindowCloseOptions): Promise<void> {
    try {
        const runningCount = await options.countRunning();
        if (runningCount > 0) {
            const decision = await options.confirm(runningCount);
            if (decision === 'cancel') return;
            if (decision === 'terminate') await options.terminateAll();
            else await options.detachAll();
        } else {
            await options.detachAll();
        }
    } catch (error) {
        options.logFailure(errorMessage(error, 'Unknown close failure'));
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

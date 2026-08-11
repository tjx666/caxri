import { AsyncSemaphore } from '../../shared/node/concurrency';

const MAX_CONCURRENT_TERMINAL_RESTORES = 4;

export type TerminalRestoreOperation = (
    isCurrent: () => boolean,
    abortSignal: AbortSignal,
) => Promise<boolean>;

/**
 * Bounds restore work across every Session and invalidates queued work when navigation changes.
 * Running executable discovery cannot be aborted safely, so each operation receives both a
 * generation check before PTY spawn and a signal that releases cancellable grid waits immediately.
 */
export class TerminalRestoreSupervisor {
    private activeSessionId?: string;
    private activeAbortController?: AbortController;
    private closed = false;
    private readonly generations = new Map<string, number>();
    private readonly restores: AsyncSemaphore;

    constructor(maximum = MAX_CONCURRENT_TERMINAL_RESTORES) {
        this.restores = new AsyncSemaphore(maximum);
    }

    restore(
        sessionId: string,
        operations: readonly TerminalRestoreOperation[],
    ): Promise<boolean[]> {
        if (this.closed) return Promise.resolve([]);
        this.activeAbortController?.abort();
        const abortController = new AbortController();
        this.activeAbortController = abortController;
        this.activeSessionId = sessionId;
        const generation = (this.generations.get(sessionId) ?? 0) + 1;
        this.generations.set(sessionId, generation);
        const isCurrent = (): boolean =>
            !this.closed &&
            !abortController.signal.aborted &&
            this.activeSessionId === sessionId &&
            this.generations.get(sessionId) === generation;

        if (operations.length === 0) return Promise.resolve([]);

        return Promise.all(
            operations.map((operation) =>
                this.restores.run(async () => {
                    if (!isCurrent()) return false;
                    return operation(isCurrent, abortController.signal);
                }),
            ),
        );
    }

    cancel(sessionId: string): void {
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
        if (this.activeSessionId !== sessionId) return;
        this.activeAbortController?.abort();
        this.activeAbortController = undefined;
        this.activeSessionId = undefined;
    }

    close(): void {
        this.closed = true;
        this.activeAbortController?.abort();
        this.activeAbortController = undefined;
        this.activeSessionId = undefined;
        this.generations.clear();
    }
}

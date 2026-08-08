import { AsyncSemaphore } from '../../shared/node/concurrency';

const MAX_CONCURRENT_TERMINAL_RESTORES = 4;

export type TerminalRestoreOperation = (isCurrent: () => boolean) => Promise<boolean>;

/**
 * Bounds restore work across every Session and invalidates queued work when navigation changes.
 * Running discovery cannot be aborted safely, so each operation receives a generation check that
 * the Terminal manager repeats immediately before spawning the PTY.
 */
export class TerminalRestoreSupervisor {
    private activeSessionId?: string;
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
        if (this.closed || operations.length === 0) return Promise.resolve([]);
        this.activeSessionId = sessionId;
        const generation = (this.generations.get(sessionId) ?? 0) + 1;
        this.generations.set(sessionId, generation);
        const isCurrent = (): boolean =>
            !this.closed &&
            this.activeSessionId === sessionId &&
            this.generations.get(sessionId) === generation;

        return Promise.all(
            operations.map((operation) =>
                this.restores.run(async () => {
                    if (!isCurrent()) return false;
                    return operation(isCurrent);
                }),
            ),
        );
    }

    cancel(sessionId: string): void {
        this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
        if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
    }

    close(): void {
        this.closed = true;
        this.activeSessionId = undefined;
        this.generations.clear();
    }
}

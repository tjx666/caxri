import { AsyncSemaphore } from '@caxri/system';

const MAX_CONCURRENT_TERMINAL_RESTORES = 4;

export type TerminalRestoreOperation = (
    isCurrent: () => boolean,
    abortSignal: AbortSignal,
) => Promise<boolean>;

export interface TerminalRestoreRequestOptions {
    /**
     * Marks a request whose operations the active restore for the same Session may not cover (for example a resume that
     * also restores `detached` Terminals while the selection restore skips them). Instead of being dropped, it waits
     * for that restore to settle and then builds and runs its own operations, so it observes the state the first one
     * left. It is abandoned, not run, when the active restore is aborted by selecting another Session, cancel, or
     * close.
     */
    afterActive?: boolean;
}

/**
 * Bounds restore work across every Session and invalidates queued work when navigation changes. Running executable
 * discovery cannot be aborted safely, so each operation receives both a generation check before PTY spawn and a signal
 * that releases cancellable grid waits immediately.
 */
export class TerminalRestoreSupervisor {
    private activeSessionId?: string;
    private activeAbortController?: AbortController;
    private activeSettled?: Promise<void>;
    private closed = false;
    private generationCounter = 0;
    private readonly generations = new Map<string, number>();
    private readonly inFlight = new Map<string, Set<Promise<unknown>>>();
    private readonly pendingRestores = new Map<string, number>();
    private readonly restores: AsyncSemaphore;

    constructor(maximum = MAX_CONCURRENT_TERMINAL_RESTORES) {
        this.restores = new AsyncSemaphore(maximum);
    }

    /**
     * Read through a method so the check after an `await` sees state that changed while the request waited.
     */
    private isQueueAbandoned(active: AbortController): boolean {
        return active.signal.aborted || this.closed;
    }

    private advanceGeneration(sessionId: string): number {
        this.generationCounter += 1;
        this.generations.set(sessionId, this.generationCounter);
        return this.generationCounter;
    }

    private beginRestore(sessionId: string): void {
        this.pendingRestores.set(sessionId, (this.pendingRestores.get(sessionId) ?? 0) + 1);
    }

    private finishRestore(sessionId: string): void {
        const pending = this.pendingRestores.get(sessionId);
        if (pending === undefined) return;
        if (pending > 1) this.pendingRestores.set(sessionId, pending - 1);
        else this.pendingRestores.delete(sessionId);
        this.pruneGeneration(sessionId);
    }

    private pruneGeneration(sessionId: string): void {
        if (this.activeSessionId === sessionId || this.pendingRestores.has(sessionId)) return;
        this.generations.delete(sessionId);
    }

    private invalidate(sessionId: string): void {
        if (this.generations.has(sessionId)) this.advanceGeneration(sessionId);
        if (this.activeSessionId === sessionId) {
            this.activeAbortController?.abort();
            this.activeAbortController = undefined;
            this.activeSessionId = undefined;
        }
        this.pruneGeneration(sessionId);
    }

    async restore(
        sessionId: string,
        request: readonly TerminalRestoreOperation[] | (() => readonly TerminalRestoreOperation[]),
        requestOptions: TerminalRestoreRequestOptions = {},
    ): Promise<boolean[]> {
        if (this.closed) return [];
        const active = this.activeAbortController;
        if (active && this.activeSessionId === sessionId && !active.signal.aborted) {
            if (!requestOptions.afterActive || !this.activeSettled) return [];
            await this.activeSettled;
            // A different Session, cancel, or close aborted the restore this request queued behind.
            if (this.isQueueAbandoned(active)) return [];
            return this.restore(sessionId, request, requestOptions);
        }
        const operations = typeof request === 'function' ? request() : request;
        this.activeAbortController?.abort();
        const abortController = new AbortController();
        const settled = Promise.withResolvers<void>();
        this.activeSettled = settled.promise;
        this.activeAbortController = abortController;
        this.activeSessionId = sessionId;
        const generation = this.advanceGeneration(sessionId);

        if (operations.length === 0) {
            this.activeAbortController = undefined;
            this.activeSessionId = undefined;
            this.activeSettled = undefined;
            settled.resolve();
            this.pruneGeneration(sessionId);
            return [];
        }
        this.beginRestore(sessionId);

        const isCurrent = (): boolean =>
            !this.closed &&
            !abortController.signal.aborted &&
            this.activeSessionId === sessionId &&
            this.generations.get(sessionId) === generation;

        const work = Promise.all(
            operations.map((operation) =>
                this.restores.run(async () => {
                    if (!isCurrent()) return false;
                    return operation(isCurrent, abortController.signal);
                }),
            ),
        );
        const sessionWork = this.inFlight.get(sessionId) ?? new Set();
        sessionWork.add(work);
        this.inFlight.set(sessionId, sessionWork);
        try {
            return await work;
        } finally {
            sessionWork.delete(work);
            if (sessionWork.size === 0 && this.inFlight.get(sessionId) === sessionWork)
                this.inFlight.delete(sessionId);
            if (this.activeAbortController === abortController) {
                this.activeAbortController = undefined;
                this.activeSessionId = undefined;
                this.activeSettled = undefined;
            }
            settled.resolve();
            this.finishRestore(sessionId);
        }
    }

    cancel(sessionId: string): void {
        this.invalidate(sessionId);
    }

    /**
     * Resolves once every restore already started for the Session has finished. `cancel` fences only work that has not
     * reached PTY spawn; a caller that must act on the resulting process (stopping it) waits here for the rest.
     */
    async settled(sessionId: string): Promise<void> {
        const work = this.inFlight.get(sessionId);
        if (work) await Promise.allSettled(work);
    }

    /**
     * Fences every queued or discovering restore without retiring the supervisor, so a restore queued before Terminate
     * and Close cannot relaunch a Terminal afterward while the next selection still restores normally.
     */
    cancelAll(): void {
        for (const sessionId of this.generations.keys()) this.invalidate(sessionId);
    }

    /**
     * Permanently retires a deleted Session while pending operations retain only the fence needed to settle safely.
     */
    forget(sessionId: string): void {
        this.invalidate(sessionId);
    }

    close(): void {
        this.closed = true;
        this.activeAbortController?.abort();
        this.activeAbortController = undefined;
        this.activeSessionId = undefined;
        this.generations.clear();
        this.pendingRestores.clear();
    }
}

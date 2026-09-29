export interface TerminalGridSize {
    cols: number;
    rows: number;
}

type AttachedSizeWaiter = () => void;

/**
 * Owns view attachment identity and the last measured grid independently from durable Terminal metadata. A Terminal can
 * be attached before its interrupted process is restored, so this registry intentionally accepts IDs with no live PTY.
 */
export class TerminalAttachments {
    private readonly attached = new Set<string>();
    private readonly sizes = new Map<string, TerminalGridSize>();
    private readonly sizeWaiters = new Map<string, Set<AttachedSizeWaiter>>();

    has(terminalId: string): boolean {
        return this.attached.has(terminalId);
    }

    size(terminalId: string): TerminalGridSize | undefined {
        return this.sizes.get(terminalId);
    }

    ids(): string[] {
        return [...this.attached];
    }

    attach(terminalId: string, size?: TerminalGridSize): { wasAttached: boolean } {
        const wasAttached = this.attached.has(terminalId);
        this.attached.add(terminalId);
        if (size) {
            this.sizes.set(terminalId, size);
            this.wake(terminalId);
        }
        return { wasAttached };
    }

    /**
     * Records a later Desktop fit for an attached view. The attach-time grid is otherwise stale after the window
     * resizes, and a mobile size lease that starts afterwards would restore that stale grid on release.
     */
    resize(terminalId: string, size: TerminalGridSize): void {
        if (this.attached.has(terminalId)) this.sizes.set(terminalId, size);
    }

    detach(terminalId: string): void {
        this.attached.delete(terminalId);
        this.sizes.delete(terminalId);
    }

    remove(terminalId: string): void {
        this.detach(terminalId);
        this.wake(terminalId);
    }

    waitForSize(terminalId: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<void> {
        if (this.sizes.has(terminalId) || timeoutMs <= 0 || abortSignal?.aborted)
            return Promise.resolve();
        return new Promise((resolve) => {
            let isCompleted = false;
            /**
             * The timer callback and explicit wake share one completion path; the boxed handle avoids a reassigned
             * binding while allowing an immediate attachment to cancel the timer.
             */
            const timerBox: { current?: NodeJS.Timeout } = {};
            const complete = (): void => {
                if (isCompleted) return;
                isCompleted = true;
                clearTimeout(timerBox.current);
                abortSignal?.removeEventListener('abort', complete);
                const waiters = this.sizeWaiters.get(terminalId);
                waiters?.delete(complete);
                if (waiters?.size === 0) this.sizeWaiters.delete(terminalId);
                resolve();
            };
            const waiters = this.sizeWaiters.get(terminalId) ?? new Set();
            waiters.add(complete);
            this.sizeWaiters.set(terminalId, waiters);
            timerBox.current = setTimeout(complete, timeoutMs);
            abortSignal?.addEventListener('abort', complete, { once: true });
        });
    }

    wake(terminalId: string): void {
        const waiters = this.sizeWaiters.get(terminalId);
        if (!waiters) return;
        for (const complete of waiters) complete();
    }

    wakeAll(): void {
        for (const terminalId of this.sizeWaiters.keys()) this.wake(terminalId);
    }
}

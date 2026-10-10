/**
 * A pending Agent launch's start signal, keyed by Terminal.
 */
interface AgentStartWaiter {
    launchId: string;
    promise: Promise<boolean>;
    resolve(isStarted: boolean): void;
}

/**
 * Lets a caller wait until a managed Agent launch activates. A Terminal holds at most one waiter, tagged with the
 * launch ID it was prepared for, so a late settlement from a retired generation can never resolve a newer launch's
 * waiter.
 */
export class AgentStartWaiters {
    private readonly waiters = new Map<string, AgentStartWaiter>();

    /**
     * Replaces any waiter of an older launch, which can no longer start, with one for `launchId`.
     */
    prepare(terminalId: string, launchId: string): void {
        this.waiters.get(terminalId)?.resolve(false);
        const { promise, resolve } = Promise.withResolvers<boolean>();
        this.waiters.set(terminalId, { launchId, promise, resolve });
    }

    settle(terminalId: string, launchId: string, isStarted: boolean): void {
        const waiter = this.waiters.get(terminalId);
        if (!waiter || waiter.launchId !== launchId) return;
        this.waiters.delete(terminalId);
        waiter.resolve(isStarted);
    }

    /**
     * True once the pending launch activates; false when none is pending, it is retired, or `timeoutMs` passes first.
     */
    async wait(terminalId: string, timeoutMs: number): Promise<boolean> {
        const waiter = this.waiters.get(terminalId);
        if (!waiter) return false;
        let timeout: NodeJS.Timeout | undefined;
        const didStart = await Promise.race([
            waiter.promise,
            new Promise<false>((resolve) => {
                timeout = setTimeout(resolve, timeoutMs, false);
                timeout.unref();
            }),
        ]);
        if (timeout) clearTimeout(timeout);
        return didStart;
    }
}

/**
 * Serializes mobile Agent writes with Terminal moves/closes and Session lifecycle changes. A Host request can be
 * delayed after Core admission, so checking Session ownership before await cannot fence a later DB reassignment or
 * deletion.
 */
export class MobileTerminalMutationQueue {
    private readonly tails = new Map<string, Promise<void>>();

    private async runKey<T>(key: string, task: () => Promise<T> | T): Promise<T> {
        const previous = this.tails.get(key);
        const release = Promise.withResolvers<void>();
        this.tails.set(key, release.promise);
        if (previous) await previous;
        try {
            return await task();
        } finally {
            release.resolve();
            if (this.tails.get(key) === release.promise) this.tails.delete(key);
        }
    }

    runMany<T>(keys: readonly string[], task: () => Promise<T> | T): Promise<T> {
        const ordered = [...new Set(keys)].toSorted((left, right) => left.localeCompare(right));
        const acquire = (index: number): Promise<T> =>
            index === ordered.length
                ? Promise.resolve(task())
                : this.runKey(ordered[index], () => acquire(index + 1));
        return acquire(0);
    }

    run<T>(terminalId: string, task: () => Promise<T> | T): Promise<T> {
        return this.runMany([`terminal:${terminalId}`], task);
    }

    runProject<T>(projectId: string, task: () => Promise<T> | T): Promise<T> {
        return this.runMany([`project:${projectId}`], task);
    }

    runProjectSessionTerminal<T>(
        projectId: string | undefined,
        sessionId: string,
        terminalId: string,
        task: () => Promise<T> | T,
    ): Promise<T> {
        return this.runMany(
            [
                projectId && `project:${projectId}`,
                `session:${sessionId}`,
                `terminal:${terminalId}`,
            ].filter((key): key is string => Boolean(key)),
            task,
        );
    }

    runSessionTerminal<T>(
        sessionId: string,
        terminalId: string,
        task: () => Promise<T> | T,
    ): Promise<T> {
        return this.runMany([`session:${sessionId}`, `terminal:${terminalId}`], task);
    }

    runSessions<T>(sessionIds: readonly string[], task: () => Promise<T> | T): Promise<T> {
        return this.runMany(
            sessionIds.map((id) => `session:${id}`),
            task,
        );
    }
}

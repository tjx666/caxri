import { KeyedSerialQueue } from '@caxri/system';

/**
 * Serializes mobile Agent writes with Terminal moves/closes and Session lifecycle changes. A Host request can be
 * delayed after Core admission, so checking Session ownership before await cannot fence a later DB reassignment or
 * deletion.
 */
export class MobileTerminalMutationQueue {
    private readonly keys = new KeyedSerialQueue<string>();

    runMany<T>(keys: readonly string[], task: () => Promise<T> | T): Promise<T> {
        const ordered = [...new Set(keys)].toSorted((left, right) => left.localeCompare(right));
        const acquire = (index: number): Promise<T> =>
            index === ordered.length
                ? Promise.resolve(task())
                : this.keys.run(ordered[index], () => acquire(index + 1));
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

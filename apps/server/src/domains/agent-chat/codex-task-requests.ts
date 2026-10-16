/**
 * Accepted blocking requests belong to the child thread and turn that asked them. Resolving one of several requests
 * must not resume that child, and a late completion of an older turn must not clear a newer turn's request.
 */
export class CodexTaskRequests {
    private readonly pending = new Map<string, { threadId: string; turnId: string | undefined }>();

    constructor(private readonly changed: (threadId: string) => void) {}

    open(key: string, threadId: string, turnId: string | undefined): void {
        this.pending.set(key, { threadId, turnId });
        this.changed(threadId);
    }

    resolve(key: string): void {
        const request = this.pending.get(key);
        if (!request) return;
        this.pending.delete(key);
        this.changed(request.threadId);
    }

    isWaiting(threadId: string): boolean {
        return this.pending.values().some((request) => request.threadId === threadId);
    }

    clearTurn(threadId: string, turnId: string): void {
        for (const [key, request] of this.pending)
            if (
                request.threadId === threadId &&
                (request.turnId === undefined || request.turnId === turnId)
            )
                this.pending.delete(key);
    }

    clear(): void {
        this.pending.clear();
    }
}

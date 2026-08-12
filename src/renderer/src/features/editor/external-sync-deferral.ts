interface ProjectOperation {
    projectId: string;
}

/** Coalesces watcher and Session-switch refreshes behind managed Project mutations. */
export class ExternalSyncDeferral {
    private readonly projects = new Set<string>();

    deferIfPending(projectId: string, operations: readonly ProjectOperation[]): boolean {
        if (!operations.some((operation) => operation.projectId === projectId)) return false;
        this.projects.add(projectId);
        return true;
    }

    flushReady(operations: readonly ProjectOperation[]): string[] {
        const ready: string[] = [];
        for (const projectId of this.projects) {
            if (operations.some((operation) => operation.projectId === projectId)) continue;
            this.projects.delete(projectId);
            ready.push(projectId);
        }
        return ready;
    }
}

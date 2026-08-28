export interface RootLoadProgress {
    completed: number;
    started: number;
}

export interface PendingTreeRefresh {
    afterRootLoad: number;
    id: string;
    targetRootLoad?: number;
}

/**
 * Binds a manual refresh to the first root load that starts after its command dispatch. A root request that was already
 * running when the user clicked may finish later, but must not clear the button's busy state for the new request.
 */
export function reconcilePendingTreeRefresh(
    pending: PendingTreeRefresh,
    progress: RootLoadProgress,
): PendingTreeRefresh | undefined {
    if (progress.completed > pending.afterRootLoad) return;
    const targetRootLoad =
        pending.targetRootLoad ??
        (progress.started > pending.afterRootLoad ? progress.started : undefined);
    if (targetRootLoad === undefined) return pending;
    return targetRootLoad === pending.targetRootLoad ? pending : { ...pending, targetRootLoad };
}

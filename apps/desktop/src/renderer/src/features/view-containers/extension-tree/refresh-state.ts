import type { TreeItemDto, ViewActionDescriptor } from '@caxri/protocol';

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
 * Routes a message's argument-free refresh command through the View header's single-flight state. A custom message
 * action remains an ordinary TreeItem command, while one refresh action must share the same duplicate-suppression and
 * busy lifecycle regardless of which visible button invoked it.
 */
export function isMessageRefreshAction(
    item: TreeItemDto,
    refreshAction: ViewActionDescriptor | undefined,
): boolean {
    const command = item.command;
    return Boolean(
        command &&
        item.variant === 'message' &&
        command.id === refreshAction?.commandId &&
        (command.arguments?.length ?? 0) === 0,
    );
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

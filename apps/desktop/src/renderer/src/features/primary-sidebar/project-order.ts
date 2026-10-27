export const PROJECT_DRAG_TYPE = 'application/x-caxri-project';

export type ProjectDropEdge = 'after' | 'before';

export interface ProjectDropTarget {
    edge: ProjectDropEdge;
    projectId: string;
}

export interface LatestProjectOrderQueue {
    enqueue(projectIds: string[]): Promise<void>;
}

interface ProjectOrderIntent {
    title: string;
    movedProjectId: string;
    projectIds: string[];
}

export interface ProjectOrderIntentTracker {
    get(): ProjectOrderIntent | undefined;
    reconcile(projectIds: readonly string[]): ProjectOrderIntent | undefined;
    set(intent: ProjectOrderIntent): void;
    settle(didSucceed: boolean): void;
}

export function hasProjectDragType(types: readonly string[]): boolean {
    return types.includes(PROJECT_DRAG_TYPE);
}

/**
 * Keeps the optimistic order authoritative until Server state confirms or rejects that intent.
 */
export function createProjectOrderIntentTracker(): ProjectOrderIntentTracker {
    let current: ProjectOrderIntent | undefined;

    return {
        get: () => current,
        reconcile(projectIds) {
            if (!current) return;
            const projectIdSet = new Set(projectIds);
            const isMembershipMatches =
                current.projectIds.length === projectIds.length &&
                current.projectIds.every((projectId) => projectIdSet.has(projectId));
            if (!isMembershipMatches) {
                current = undefined;
                return;
            }
            if (current.projectIds.some((projectId, index) => projectId !== projectIds[index]))
                return;
            const confirmed = current;
            current = undefined;
            return confirmed;
        },
        set(intent) {
            current = intent;
        },
        /**
         * A newer queued intent still depends on the failed optimistic order, so it must be discarded along with the
         * rejected request instead of being persisted against stale Server state.
         */
        settle(didSucceed) {
            if (!didSucceed) current = undefined;
        },
    };
}

/**
 * Persists one in-flight order and replaces queued intermediate orders with the latest intent.
 */
export function createLatestProjectOrderQueue(
    persist: (projectIds: string[]) => Promise<void>,
): LatestProjectOrderQueue {
    let latest: string[] | undefined;
    let worker: Promise<void> | undefined;

    const drain = async (): Promise<void> => {
        while (latest) {
            const projectIds = latest;
            latest = undefined;
            // Intentionally sequential: each persisted order must land before the next queued
            // (possibly superseding) order is sent.
            // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
            await persist(projectIds);
        }
    };
    const runWorker = async (): Promise<void> => {
        try {
            await drain();
        } finally {
            worker = undefined;
        }
    };

    return {
        enqueue(projectIds) {
            latest = projectIds;
            worker ??= runWorker();
            return worker;
        },
    };
}

/**
 * Lets high-frequency dragover events retain React state when the visible insertion point is unchanged.
 */
export function areProjectDropTargetsEqual(
    first: ProjectDropTarget | undefined,
    second: ProjectDropTarget | undefined,
): boolean {
    return first?.edge === second?.edge && first?.projectId === second?.projectId;
}

/**
 * Returns the complete Project permutation produced by one before/after insertion.
 */
export function projectOrderAfterDrop(
    projectIds: readonly string[],
    draggedProjectId: string,
    targetProjectId: string,
    edge: ProjectDropEdge,
): string[] {
    if (draggedProjectId === targetProjectId) return [...projectIds];
    const reordered = projectIds.filter((projectId) => projectId !== draggedProjectId);
    const targetIndex = reordered.indexOf(targetProjectId);
    if (targetIndex === -1 || !projectIds.includes(draggedProjectId)) return [...projectIds];
    reordered.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, draggedProjectId);
    return reordered;
}

export function adjacentProjectOrder(
    projectIds: readonly string[],
    projectId: string,
    delta: -1 | 1,
): string[] | undefined {
    const index = projectIds.indexOf(projectId);
    const targetIndex = index + delta;
    if (index === -1 || targetIndex < 0 || targetIndex >= projectIds.length) return undefined;
    const reordered = [...projectIds];
    const movedProjectId = reordered[index];
    reordered[index] = reordered[targetIndex];
    reordered[targetIndex] = movedProjectId;
    return reordered;
}

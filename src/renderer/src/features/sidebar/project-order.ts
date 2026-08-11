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
    displayTitle: string;
    movedProjectId: string;
    projectIds: string[];
}

export interface ProjectOrderIntentTracker {
    get(): ProjectOrderIntent | undefined;
    reconcile(projectIds: readonly string[]): ProjectOrderIntent | undefined;
    set(intent: ProjectOrderIntent): void;
    settle(succeeded: boolean): void;
}

export function hasProjectDragType(types: readonly string[]): boolean {
    return types.includes(PROJECT_DRAG_TYPE);
}

/** Keeps the optimistic order authoritative until Runtime state confirms or rejects that intent. */
export function createProjectOrderIntentTracker(): ProjectOrderIntentTracker {
    let current: ProjectOrderIntent | undefined;

    return {
        get: () => current,
        reconcile(projectIds) {
            if (!current) return undefined;
            const projectIdSet = new Set(projectIds);
            const membershipMatches =
                current.projectIds.length === projectIds.length &&
                current.projectIds.every((projectId) => projectIdSet.has(projectId));
            if (!membershipMatches) {
                current = undefined;
                return undefined;
            }
            if (current.projectIds.some((projectId, index) => projectId !== projectIds[index]))
                return undefined;
            const confirmed = current;
            current = undefined;
            return confirmed;
        },
        set(intent) {
            current = intent;
        },
        /**
         * A newer queued intent still depends on the failed optimistic order, so it must be
         * discarded along with the rejected request instead of being persisted against stale
         * Runtime state.
         */
        settle(succeeded) {
            if (!succeeded) current = undefined;
        },
    };
}

/** Persists one in-flight order and replaces queued intermediate orders with the latest intent. */
export function createLatestProjectOrderQueue(
    persist: (projectIds: string[]) => Promise<void>,
): LatestProjectOrderQueue {
    let latest: string[] | undefined;
    let worker: Promise<void> | undefined;

    const drain = async (): Promise<void> => {
        while (latest) {
            const projectIds = latest;
            latest = undefined;
            await persist(projectIds);
        }
    };

    return {
        enqueue(projectIds) {
            latest = projectIds;
            worker ??= drain().finally(() => {
                worker = undefined;
            });
            return worker;
        },
    };
}

/** Lets high-frequency dragover events retain React state when the visible insertion point is unchanged. */
export function projectDropTargetsEqual(
    first: ProjectDropTarget | undefined,
    second: ProjectDropTarget | undefined,
): boolean {
    return first?.edge === second?.edge && first?.projectId === second?.projectId;
}

/** Returns the complete Project permutation produced by one before/after insertion. */
export function projectOrderAfterDrop(
    projectIds: readonly string[],
    draggedProjectId: string,
    targetProjectId: string,
    edge: ProjectDropEdge,
): string[] {
    if (draggedProjectId === targetProjectId) return [...projectIds];
    const reordered = projectIds.filter((projectId) => projectId !== draggedProjectId);
    const targetIndex = reordered.indexOf(targetProjectId);
    if (targetIndex < 0 || !projectIds.includes(draggedProjectId)) return [...projectIds];
    reordered.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, draggedProjectId);
    return reordered;
}

export interface ProjectHeadingClickEffect {
    select: boolean;
    toggle: boolean;
}

/**
 * Decouples selecting a Project from expanding/collapsing it: clicking an already-active Project
 * still toggles disclosure as before, but clicking an inactive Project only ever selects it and
 * auto-expands when collapsed, never collapses an already-expanded Project on selection.
 */
export function resolveProjectHeadingClick(
    active: boolean,
    expanded: boolean,
): ProjectHeadingClickEffect {
    if (!active) return { select: true, toggle: !expanded };
    return { select: false, toggle: true };
}

export function adjacentProjectOrder(
    projectIds: readonly string[],
    projectId: string,
    delta: -1 | 1,
): string[] | undefined {
    const index = projectIds.indexOf(projectId);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= projectIds.length) return undefined;
    const reordered = [...projectIds];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    return reordered;
}

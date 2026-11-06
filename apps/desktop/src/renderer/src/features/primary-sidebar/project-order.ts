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

/**
 * The index `project.reorder` expects for a moved Project. Each machine's Server orders only its own Projects, while
 * the sidebar shows every machine's Projects in one list, so the index counts only the Projects before it on the same
 * machine.
 */
export function machineProjectIndex(
    projectIds: readonly string[],
    movedProjectId: string,
    machineOf: (projectId: string) => string | undefined,
): number {
    const machine = machineOf(movedProjectId);
    let index = 0;
    for (const projectId of projectIds) {
        if (projectId === movedProjectId) return index;
        if (machineOf(projectId) === machine) index += 1;
    }
    return index;
}

/**
 * The `project.reorder` calls that persist a heading move. The sidebar orders headings, but each machine's Server
 * orders every Project on that machine, including the ones merged under another heading. So the heading order is
 * expanded to its members (a heading's members stay adjacent), and every member of the moved heading gets its own call
 * with the index counted among its machine's Projects.
 *
 * @param headingIds The sidebar order, by heading id (the lead Project's id).
 * @param movedHeadingId The heading that was moved.
 * @param membersOf The Project ids under a heading; a heading missing from it holds only itself.
 */
export function projectReorderTargets(
    headingIds: readonly string[],
    movedHeadingId: string,
    membersOf: (headingId: string) => readonly string[] | undefined,
    machineOf: (projectId: string) => string | undefined,
): Array<{ projectId: string; targetIndex: number }> {
    const expanded = headingIds.flatMap((headingId) => membersOf(headingId) ?? [headingId]);
    return (membersOf(movedHeadingId) ?? [movedHeadingId]).map((projectId) => ({
        projectId,
        targetIndex: machineProjectIndex(expanded, projectId, machineOf),
    }));
}

/**
 * Decides which Project order the sidebar draws. The Server re-sorts Projects the moment an Agent starts or stops,
 * which would replace the row under the pointer mid-click or mid-drag, so while `isHeld` is on the displayed order
 * stays put. A change in membership (a Project added, removed, or merged) always applies at once: a held order cannot
 * draw a row that no longer exists or omit one that does.
 */
export function resolveHeldProjectOrder(
    displayed: readonly string[],
    latest: readonly string[],
    isHeld: boolean,
): readonly string[] {
    if (!isHeld || displayed.length !== latest.length) return latest;
    const latestSet = new Set(latest);
    return displayed.every((projectId) => latestSet.has(projectId)) ? displayed : latest;
}

/**
 * Sorts items into `order`; ids missing from `order` keep their relative position after the ordered ones.
 */
export function sortByProjectOrder<T>(
    items: readonly T[],
    order: readonly string[],
    idOf: (item: T) => string,
): T[] {
    const rank = new Map(order.map((projectId, index) => [projectId, index]));
    return items
        .map((item, index) => ({ index, item, rank: rank.get(idOf(item)) ?? order.length }))
        .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.item);
}

export interface ProjectMove {
    movedProjectId: string;
    /**
     * 1-based position in the new order.
     */
    position: number;
    total: number;
}

/**
 * The one Project that moved between two orders of the same members, for the live-region announcement. Returns the
 * first id whose removal leaves the remaining relative order identical; undefined when nothing moved.
 */
export function projectMoveBetween(
    previous: readonly string[],
    next: readonly string[],
): ProjectMove | undefined {
    if (previous.length !== next.length || previous.every((id, index) => id === next[index]))
        return undefined;
    for (const [index, candidate] of next.entries()) {
        const rest = (ids: readonly string[]) => ids.filter((id) => id !== candidate);
        const before = rest(previous);
        const after = rest(next);
        if (
            before.length === after.length &&
            before.every((id, position) => id === after[position]) &&
            previous.indexOf(candidate) !== index
        )
            return { movedProjectId: candidate, position: index + 1, total: next.length };
    }
    return undefined;
}

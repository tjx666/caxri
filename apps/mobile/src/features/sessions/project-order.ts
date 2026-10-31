/**
 * Where one Project filter chip sits along the horizontal strip, in content coordinates.
 */
export interface ProjectChipSlot {
    x: number;
    width: number;
}

export interface ProjectReorderRequest {
    projectId: string;
    anchorProjectId: string;
    placement: 'before' | 'after';
}

/**
 * Applies a move the phone has made but the next dashboard has not confirmed yet. An order that no longer names exactly
 * the current Projects (one was added or lost its grant meanwhile) is dropped rather than half-applied.
 */
export const orderedProjects = <Project extends { id: string }>(
    projects: Project[],
    order: readonly string[] | null,
): Project[] => {
    if (order?.length !== projects.length) return projects;
    const byId = new Map(projects.map((project) => [project.id, project]));
    const result: Project[] = [];
    for (const id of order) {
        const project = byId.get(id);
        if (!project) return projects;
        result.push(project);
    }
    return result;
};

/**
 * Moves `projectId` to `toIndex` and names the neighbor it lands beside, because the Server places a phone's move
 * relative to a Project the phone can see rather than at a global index. Returns `null` when nothing moves.
 */
export const projectReorder = (
    ids: readonly string[],
    projectId: string,
    toIndex: number,
): { order: string[]; request: ProjectReorderRequest } | null => {
    const from = ids.indexOf(projectId);
    if (from === -1 || ids.length < 2) return null;
    const target = Math.min(ids.length - 1, Math.max(0, toIndex));
    if (target === from) return null;
    const order = ids.filter((id) => id !== projectId);
    order.splice(target, 0, projectId);
    return {
        order,
        request:
            target === 0
                ? { projectId, anchorProjectId: order[1], placement: 'before' }
                : { projectId, anchorProjectId: order[target - 1], placement: 'after' },
    };
};

/**
 * The index a dragged chip would take: one past every other chip whose center it has crossed.
 */
export const projectDropIndex = (
    slots: readonly ProjectChipSlot[],
    from: number,
    draggedCenter: number,
): number => {
    'worklet';
    let index = 0;
    for (const [slotIndex, slot] of slots.entries())
        if (slotIndex !== from && slot.x + slot.width / 2 < draggedCenter) index += 1;
    return index;
};

/**
 * How far a chip that is not being dragged steps aside: the chips between the dragged chip's old and new place close
 * the gap it left, by its width plus the strip's gap.
 */
export const projectChipShift = (
    index: number,
    from: number,
    to: number,
    draggedSpan: number,
): number => {
    'worklet';
    if (index === from || from < 0) return 0;
    if (from < index && index <= to) return -draggedSpan;
    if (to <= index && index < from) return draggedSpan;
    return 0;
};

/**
 * Pixels to scroll this frame while a chip is held near an edge of the strip, faster the closer it gets; zero away from
 * the edges or once the strip cannot scroll further that way.
 */
export const projectAutoScrollStep = ({
    chipLeft,
    chipWidth,
    edge,
    maxOffset,
    maxStep,
    offset,
    viewportWidth,
}: {
    /**
     * The dragged chip's left edge relative to the visible strip.
     */
    chipLeft: number;
    chipWidth: number;
    edge: number;
    maxOffset: number;
    maxStep: number;
    offset: number;
    viewportWidth: number;
}): number => {
    'worklet';
    const overRight = chipLeft + chipWidth - (viewportWidth - edge);
    if (overRight > 0 && offset < maxOffset)
        return Math.min(maxOffset - offset, maxStep * Math.min(1, overRight / edge));
    const overLeft = edge - chipLeft;
    if (overLeft > 0 && offset > 0)
        return -Math.min(offset, maxStep * Math.min(1, overLeft / edge));
    return 0;
};

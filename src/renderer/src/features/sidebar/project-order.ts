export const PROJECT_DRAG_TYPE = 'application/x-caxri-project';

export type ProjectDropEdge = 'after' | 'before';

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

import type { SessionListEntry } from './hooks/use-session-polling';

export const activeProjectFilter = (
    selectedProjectId: string | null,
    projects: ReadonlyArray<{ id: string }>,
): string | null =>
    selectedProjectId !== null && projects.some(({ id }) => id === selectedProjectId)
        ? selectedProjectId
        : null;
export const filterSessionEntries = (
    entries: SessionListEntry[],
    projectId: string | null,
): SessionListEntry[] => {
    if (projectId === null) return entries;
    const result: SessionListEntry[] = [];
    let header: SessionListEntry | null = null;
    for (const entry of entries) {
        if (entry.type === 'header') {
            header = entry;
            continue;
        }
        if (entry.session.projectId !== projectId) continue;
        if (header) {
            result.push(header);
            header = null;
        }
        result.push(entry);
    }
    return result;
};

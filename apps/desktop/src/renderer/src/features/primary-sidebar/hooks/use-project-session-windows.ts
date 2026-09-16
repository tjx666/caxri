import { useCallback, useMemo, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import type { SessionListWindow } from '../session-list-window';
import { nextRevealedSessionCount, sessionListWindow } from '../session-list-window';

export interface ProjectSessionWindow extends SessionListWindow<SessionRecord> {
    project: ProjectRecord;
    projectSessions: SessionRecord[];
}

interface UseProjectSessionWindowsInput {
    projects: readonly ProjectRecord[];
    selectedSessionId: string | undefined;
    /**
     * Every active Session already in sidebar order, across all Projects.
     */
    sidebarSessions: readonly SessionRecord[];
}

/**
 * Owns how many Sessions each Project currently shows. The revealed counts are deliberately kept in memory only: a
 * relaunch should start from the short list again, the same way it starts scrolled to the top.
 */
export function useProjectSessionWindows({
    projects,
    selectedSessionId,
    sidebarSessions,
}: UseProjectSessionWindowsInput) {
    const [revealedCounts, setRevealedCounts] = useState<Record<string, number>>({});

    const windows = useMemo(
        () =>
            projects.map((project) => {
                // Single pass instead of `.filter().map()`: react-doctor's combine-iterations rule
                // flags the chained form even though both walk the same small `sessions` array.
                const projectSessions: SessionRecord[] = [];
                for (const session of sidebarSessions)
                    if (session.projectId === project.id) projectSessions.push(session);
                return {
                    project,
                    projectSessions,
                    ...sessionListWindow(
                        projectSessions,
                        revealedCounts[project.id],
                        selectedSessionId,
                    ),
                };
            }),
        [projects, revealedCounts, selectedSessionId, sidebarSessions],
    );

    /**
     * Steps one Project's window forward, measured from the in-order prefix on screen rather than the stored revealed
     * count, so a window clamped to a short Session list steps from what the user can actually see.
     */
    const revealMore = useCallback((projectId: string, windowCount: number): void => {
        setRevealedCounts((current) => ({
            ...current,
            [projectId]: nextRevealedSessionCount(windowCount),
        }));
    }, []);

    return { revealMore, windows };
}

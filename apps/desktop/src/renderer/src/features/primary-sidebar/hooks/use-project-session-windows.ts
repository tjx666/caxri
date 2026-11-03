import { useCallback, useMemo, useState } from 'react';

import type { ProjectRecord, SessionListWindow, SessionRecord } from '@caxri/protocol';
import { nextRevealedSessionCount, sessionListWindow } from '@caxri/protocol';

import type { MergedProject } from '../project-merge';

export interface ProjectSessionWindow extends SessionListWindow<SessionRecord> {
    /**
     * The heading's Project: the lead of a repository merged across machines.
     */
    project: ProjectRecord;
    /**
     * Every Project under the heading, `project` first; more than one when the repository lives on several machines.
     */
    members: readonly ProjectRecord[];
    /**
     * The Project's own Sessions with an ordinary row, in sidebar order. This is what its session count and its window
     * measure.
     */
    projectSessions: SessionRecord[];
    /**
     * `projectSessions` plus the nested and hidden Sessions its hosts hold, for the status counts a collapsed heading
     * shows: a running or unread child must not fold out of sight with its host. The same array as `projectSessions`
     * when no host holds any.
     */
    statusSessions: SessionRecord[];
}

interface UseProjectSessionWindowsInput {
    /**
     * The nested and hidden Sessions each group holds through its hosts (`DelegatedPlacement.hostedByGroup`).
     */
    hostedByGroup?: ReadonlyMap<string, readonly SessionRecord[]>;
    /**
     * The side bar's Project headings, in order (`mergeProjectsByRepository`).
     */
    projects: readonly MergedProject[];
    /**
     * The host of the selected Session when that Session is nested. The host's row stays inside its Project's window
     * like a selected row, so the selection is never folded away behind `Show N more`.
     */
    selectedHostSessionId?: string;
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
    hostedByGroup,
    projects,
    selectedHostSessionId,
    selectedSessionId,
    sidebarSessions,
}: UseProjectSessionWindowsInput) {
    const [revealedCounts, setRevealedCounts] = useState<Record<string, number>>({});

    const windows = useMemo(
        () =>
            projects.map(({ lead: project, members }) => {
                const memberIds = new Set(members.map((member) => member.id));
                // Single pass instead of `.filter().map()`: react-doctor's combine-iterations rule
                // flags the chained form even though both walk the same small `sessions` array.
                const projectSessions: SessionRecord[] = [];
                for (const session of sidebarSessions)
                    if (memberIds.has(session.projectId)) projectSessions.push(session);
                const hosted = members.flatMap((member) => hostedByGroup?.get(member.id) ?? []);
                return {
                    project,
                    members,
                    projectSessions,
                    statusSessions:
                        hosted.length > 0 ? [...projectSessions, ...hosted] : projectSessions,
                    ...sessionListWindow(
                        projectSessions,
                        revealedCounts[project.id],
                        selectedSessionId,
                        { selectedHostSessionId },
                    ),
                };
            }),
        [
            hostedByGroup,
            projects,
            revealedCounts,
            selectedHostSessionId,
            selectedSessionId,
            sidebarSessions,
        ],
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

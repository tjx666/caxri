import { useCallback, useMemo, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import { didReorderPinnedSession } from '../../session/session-commands';
import { pinnedSessionDropTarget, pinnedSessions } from '../pinned-session-order';
import { PINNED_GROUP_ROW_ID } from '../primary-sidebar-tree';
import { sessionWorktreeProject } from '../project-visibility';
import type { SessionListWindow } from '../session-list-window';
import {
    nextRevealedSessionCount,
    revealedCountIncluding,
    sessionListWindow,
} from '../session-list-window';
import type { SessionOrderController } from './use-session-order';
import { useSessionOrder } from './use-session-order';

/**
 * `useSessionOrder`'s `groupOf` option. A named function rather than an inline arrow at the call site below, so its
 * identity stays stable across renders: `useSessionOrder` now memoizes its returned controller, and an inline arrow
 * passed in fresh on every render would silently re-invalidate that memoization for every Pinned-group re-render (issue
 * #1108).
 */
function pinnedGroupOf(): string {
    return PINNED_GROUP_ROW_ID;
}

interface PinnedSessionGroupInput {
    /**
     * The full Project catalog, hidden worktree entries included: a pinned Session's owner may be one of them.
     */
    projects: readonly ProjectRecord[];
    selectedSessionId: string | undefined;
    /**
     * Every Session, unfiltered. Deliberately not the Project groups' list, which is already frozen and ordered for
     * their own drag; the Pinned group is a separate list with its own order.
     */
    sessions: readonly SessionRecord[];
}

export interface PinnedSessionGroupModel extends SessionListWindow<SessionRecord> {
    /**
     * Owning Project keyed by Session id, for the Project name each row shows beside its title.
     */
    projects: Record<string, ProjectRecord | undefined>;
    /**
     * Its own drag controller: one that accepts a drop between two Projects and writes `session.reorderPinned`. Sharing
     * the Project groups' controller would make a drag in either group move the rows in both.
     */
    sessionOrder: SessionOrderController;
    /**
     * Steps the window forward by one reveal.
     */
    revealMore: () => void;
    /**
     * Opens the window down to one pinned Session, for a pin that landed below it.
     */
    revealSession: (sessionId: string) => void;
    /**
     * Every pinned Session in Pinned order, frozen while a drag is in flight, including the ones the window hides, so
     * the heading's count stays the real membership.
     */
    sessions: SessionRecord[];
    /**
     * Workbench Root Projects keyed by Session id. Resolved separately from the Project groups' equivalent, which only
     * covers the Sessions those groups render: a pinned Session in a collapsed Project is not in that set.
     */
    worktreeProjects: Record<string, ProjectRecord>;
}

/**
 * Everything the Pinned group renders from: its membership, its order, its drag, and the two per-Session lookups its
 * rows need. Extracted from `PrimarySidebar` so that component keeps owning only the tree's layout and focus.
 */
export function usePinnedSessionGroup({
    projects,
    selectedSessionId,
    sessions,
}: PinnedSessionGroupInput): PinnedSessionGroupModel {
    const pinned = useMemo(() => pinnedSessions(sessions), [sessions]);
    const { controller: sessionOrder, sessions: groupSessions } = useSessionOrder(pinned, {
        dropTargetAt: pinnedSessionDropTarget,
        groupOf: pinnedGroupOf,
        reorder: didReorderPinnedSession,
    });
    /**
     * Kept in memory only, like each Project's window: a relaunch starts from the short list again.
     */
    const [revealedCount, setRevealedCount] = useState<number>();
    const listWindow = useMemo(
        () => sessionListWindow(groupSessions, revealedCount, selectedSessionId),
        [groupSessions, revealedCount, selectedSessionId],
    );
    const windowCount = listWindow.windowCount;
    const revealMore = useCallback(
        () => setRevealedCount(nextRevealedSessionCount(windowCount)),
        [windowCount],
    );
    const revealSession = useCallback(
        (sessionId: string) => {
            const index = groupSessions.findIndex((session) => session.id === sessionId);
            if (index === -1) return;
            const count = revealedCountIncluding(index, windowCount);
            if (count !== undefined) setRevealedCount(count);
        },
        [groupSessions, windowCount],
    );
    const projectsById = useMemo(
        () => new Map(projects.map((project) => [project.id, project])),
        [projects],
    );
    const owningProjects = useMemo(() => {
        const resolved: Record<string, ProjectRecord | undefined> = {};
        for (const session of groupSessions)
            resolved[session.id] = projectsById.get(session.projectId);
        return resolved;
    }, [projectsById, groupSessions]);
    const worktreeProjects = useMemo(() => {
        const resolved: Record<string, ProjectRecord> = {};
        for (const session of groupSessions) {
            const worktree = sessionWorktreeProject(session, projects);
            if (worktree) resolved[session.id] = worktree;
        }
        return resolved;
    }, [projects, groupSessions]);
    return {
        ...listWindow,
        projects: owningProjects,
        revealMore,
        revealSession,
        sessionOrder,
        sessions: groupSessions,
        worktreeProjects,
    };
}

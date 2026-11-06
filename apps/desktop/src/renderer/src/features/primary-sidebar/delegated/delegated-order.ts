import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { compareSessionSidebarOrder } from '@caxri/protocol';

import { pinnedSessions } from '../pinned-session-order';
import type { DelegatedPlacement } from './delegated-placement';
import { placeDelegatedSessions } from './delegated-placement';

/**
 * The Sessions with an ordinary row, grouped by Project and sorted the way each Project group lists them. Project order
 * stays explicit; only the Sessions inside a Project follow their durable sidebar position.
 */
export function rowSessionsByProject(
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>,
    placement: Pick<DelegatedPlacement, 'rows'>,
): SessionRecord[] {
    const byProject = new Map<string, SessionRecord[]>();
    for (const session of placement.rows) {
        const bucket = byProject.get(session.projectId);
        if (bucket) bucket.push(session);
        else byProject.set(session.projectId, [session]);
    }
    return projects.flatMap((project) =>
        (byProject.get(project.id) ?? []).toSorted(compareSessionSidebarOrder),
    );
}

export interface SidebarSessionOrder {
    /**
     * Every Session the sidebar can reach, hidden consults included, for surfaces that search or pick: the command
     * palette and the share dialog.
     */
    all: SessionRecord[];
    /**
     * `all` without the hidden consults, for stepping through what the sidebar shows (previous and next Session). The
     * selected consult is not hidden, so it stays in the order and stepping away from it works.
     */
    navigable: SessionRecord[];
    placement: DelegatedPlacement;
}

/**
 * The one logical Session order behind previous/next Session, the command palette, and the share dialog: Project order,
 * then the sidebar order inside a Project, with every nested Session right after its host. A nested Session follows its
 * host even when the host's child window folds it behind `Show N more`, and a host's hidden consults close its run.
 *
 * `humanControlledSessionIds` are the delegated Sessions the user took over, which the Project tree lists as ordinary
 * rows (see `placeDelegatedSessions`); a caller without the feed leaves them after their host.
 *
 * Pinning does not reorder this list (the Pinned group is a view, not a position); a pinned Session keeps its Project
 * slot, as before nesting existed. Activity mode does not use this order.
 */
export function sidebarSessionOrder(
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>,
    sessions: readonly SessionRecord[],
    selectedSessionId?: string,
    humanControlledSessionIds?: ReadonlySet<string>,
): SidebarSessionOrder {
    const placement = placeDelegatedSessions({
        humanControlledSessionIds,
        projects,
        selectedSessionId,
        sessions,
    });
    const all: SessionRecord[] = [];
    const navigable: SessionRecord[] = [];
    for (const row of rowSessionsByProject(projects, placement)) {
        const nested = placement.nestedByHost.get(row.id) ?? [];
        const hidden = placement.hiddenByHost.get(row.id) ?? [];
        all.push(row, ...nested, ...hidden);
        navigable.push(row, ...nested);
    }
    return { all, navigable, placement };
}

/**
 * The Session that selecting a Project opens: its first Session in sidebar order. A nested Session whose own Project
 * this is lives under a host in another group, so an ordinary row of the Project wins, and a nested Session is only the
 * answer for a Project that has no row of its own.
 */
export function firstSessionOfProject(
    order: Pick<SidebarSessionOrder, 'navigable' | 'placement'>,
    projectId: string,
): SessionRecord | undefined {
    const inProject = order.navigable.filter((session) => session.projectId === projectId);
    return (
        inProject.find((session) => order.placement.byId.get(session.id)?.kind === 'row') ??
        inProject[0]
    );
}

/**
 * The Pinned group's Sessions as the sidebar renders them: a pinned consult hidden under a listed ancestor takes no
 * Pinned row, so surfaces that offer or step through the Pinned group (palette commands, `Cmd+<position>`) must not
 * count it.
 */
export function placedPinnedSessions(
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>,
    sessions: readonly SessionRecord[],
    selectedSessionId?: string,
): SessionRecord[] {
    const { placement } = sidebarSessionOrder(projects, sessions, selectedSessionId);
    const rowIds = new Set(placement.rows.map(({ id }) => id));
    return pinnedSessions(sessions).filter(({ id }) => rowIds.has(id));
}

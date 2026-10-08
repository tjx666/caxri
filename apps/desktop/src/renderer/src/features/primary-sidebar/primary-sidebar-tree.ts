/**
 * Pure row-order and arrow-key math for the PrimarySidebar's ARIA tree. Kept separate from
 * `ProjectGroup`/`PrimarySidebar` so the navigation logic is covered by fast unit tests instead of an Electron E2E
 * workflow (see the `unit-testing` skill).
 */

export interface PrimarySidebarProjectNode {
    /**
     * True when the Session window hides at least one Session, which is what puts the reveal row on screen.
     */
    hasHiddenSessions?: boolean;
    id: string;
    /**
     * Only the Sessions the window actually renders; hidden Sessions must stay out of the row order.
     */
    sessionIds: readonly string[];
}

export interface PrimarySidebarTreeRow {
    id: string;
    kind: 'project' | 'session' | 'reveal' | 'createSession';
    /**
     * The owning group's heading row id; equals `id` itself for a Project row, and `PINNED_GROUP_ROW_ID` for everything
     * inside the Pinned group. Named for the Project because that is what it is everywhere except that one group.
     */
    projectId: string;
    /**
     * The Session this row acts on, for `kind: 'session'` only. Distinct from `id` because a row inside the Pinned
     * group carries a namespaced row id rather than the Session id; every action still has to reach the Session
     * itself.
     */
    sessionId?: string;
}

/**
 * Heading row of the Pinned group. A constant rather than a Project id because the group is global (it collects
 * Sessions from every Project), so no Project owns it.
 */
export const PINNED_GROUP_ROW_ID = 'pinned-sessions';

const PINNED_SESSION_ROW_PREFIX = 'pinned-session:';

/**
 * Row id of a Session's row inside the Pinned group. Namespaced for the same reason the reveal and "New Session" rows
 * are: the tree addresses rows by id, and the Pinned group is a second place a Session row can live. Pinning moves the
 * Session rather than copying it, so the two ids cannot collide today, but keeping the namespace means a row id still
 * says which group it belongs to, which is what `focusRow`'s `[data-row-id]` lookup and the roving Tab stop address.
 */
export function primarySidebarPinnedRowId(sessionId: string): string {
    return `${PINNED_SESSION_ROW_PREFIX}${sessionId}`;
}

/**
 * Row id of a Project's "show more Sessions" row. Namespaced so it can never collide with a Session id.
 */
export function primarySidebarRevealRowId(projectId: string): string {
    return `reveal-sessions:${projectId}`;
}

/**
 * Row id of the "New Session" row a Project with no Sessions shows in place of its Session list. Namespaced like the
 * reveal row so it can never collide with a Session id.
 */
export function primarySidebarCreateSessionRowId(projectId: string): string {
    return `create-session:${projectId}`;
}

export interface PrimarySidebarPinnedNode {
    expanded: boolean;
    /**
     * True when the group's window hides at least one pinned Session, which is what puts its reveal row on screen.
     */
    hasHiddenSessions?: boolean;
    /**
     * The pinned Sessions the window actually renders, in group order. An empty list renders no group at all, heading
     * included.
     */
    sessionIds: readonly string[];
}

/**
 * Flattens the PrimarySidebar into the exact row order arrow-key navigation should walk: the Pinned group when it has
 * anything in it, then each Project heading followed by its visible Sessions and its reveal row while that Project is
 * expanded. Matches `DisclosureMotion`'s collapsed state and the Session window exactly so focus never lands on a
 * hidden row.
 *
 * The Pinned heading is emitted as a `'project'` row because it behaves as one for every key the tree handles: Left
 * collapses it, Right opens it and steps inside, and `PINNED_GROUP_ROW_ID` stands in for the Project id it has no owner
 * for.
 *
 * An expanded Project with no visible Sessions renders the "New Session" row in place of that list, so it takes the
 * Session rows' place here too. The condition is read straight off `sessionIds` rather than a separate emptiness flag:
 * `ProjectGroup` renders that row on exactly the same test, and two sources of truth for one row would eventually
 * disagree and put focus on a row that is not on screen.
 */
export function flattenPrimarySidebarRows(
    projects: readonly PrimarySidebarProjectNode[],
    isExpanded: (projectId: string) => boolean,
    pinned?: PrimarySidebarPinnedNode,
): PrimarySidebarTreeRow[] {
    const rows: PrimarySidebarTreeRow[] = [];
    if (pinned && pinned.sessionIds.length > 0) {
        rows.push({
            id: PINNED_GROUP_ROW_ID,
            kind: 'project',
            projectId: PINNED_GROUP_ROW_ID,
        });
        if (pinned.expanded) {
            for (const sessionId of pinned.sessionIds)
                rows.push({
                    id: primarySidebarPinnedRowId(sessionId),
                    kind: 'session',
                    projectId: PINNED_GROUP_ROW_ID,
                    sessionId,
                });
            if (pinned.hasHiddenSessions)
                rows.push({
                    id: primarySidebarRevealRowId(PINNED_GROUP_ROW_ID),
                    kind: 'reveal',
                    projectId: PINNED_GROUP_ROW_ID,
                });
        }
    }
    for (const project of projects) {
        rows.push({ id: project.id, kind: 'project', projectId: project.id });
        if (!isExpanded(project.id)) continue;
        for (const sessionId of project.sessionIds)
            rows.push({ id: sessionId, kind: 'session', projectId: project.id, sessionId });
        if (project.hasHiddenSessions)
            rows.push({
                id: primarySidebarRevealRowId(project.id),
                kind: 'reveal',
                projectId: project.id,
            });
        if (project.sessionIds.length === 0)
            rows.push({
                id: primarySidebarCreateSessionRowId(project.id),
                kind: 'createSession',
                projectId: project.id,
            });
    }
    return rows;
}

export type PrimarySidebarVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

/**
 * Returns the row id roving focus should move to for Up/Down/Home/End, or `undefined` when the key does not move focus
 * (empty tree, or already at an edge).
 */
export function nextPrimarySidebarRowId(
    rows: readonly PrimarySidebarTreeRow[],
    activeRowId: string | undefined,
    key: PrimarySidebarVerticalKey,
): string | undefined {
    if (rows.length === 0) return undefined;
    if (key === 'Home') return rows[0]?.id;
    if (key === 'End') return rows.at(-1)?.id;
    const currentIndex = rows.findIndex((row) => row.id === activeRowId);
    if (currentIndex === -1) return rows[0]?.id;
    const nextIndex = currentIndex + (key === 'ArrowDown' ? 1 : -1);
    return nextIndex >= 0 && nextIndex < rows.length ? rows[nextIndex]?.id : undefined;
}

export interface PrimarySidebarHorizontalIntent {
    /**
     * Present when Left/Right should flip a Project's expanded state.
     */
    expanded?: boolean;
    /**
     * Present when Left/Right should move roving focus to a different row.
     */
    focusRowId?: string;
}

/**
 * Row id of the first row nested under a Project heading, or `undefined` when the Project renders none.
 * `flattenPrimarySidebarRows` emits a Project's rows immediately after its heading, so the candidate is always the next
 * row; it is still tested against the owning Project so a Project with nothing below it cannot step into the next
 * Project's heading.
 */
function firstPrimarySidebarChildRowId(
    rows: readonly PrimarySidebarTreeRow[],
    projectRow: PrimarySidebarTreeRow,
): string | undefined {
    const index = rows.findIndex((candidate) => candidate.id === projectRow.id);
    if (index === -1) return undefined;
    const next = rows.at(index + 1);
    if (!next) return undefined;
    return next.kind !== 'project' && next.projectId === projectRow.projectId ? next.id : undefined;
}

/**
 * Resolves Left/Right on a tree row per the standard ARIA tree authoring pattern: Right opens a collapsed Project and
 * steps into the first row of an already open one, Left closes an open Project. A Session, reveal, or "New Session" row
 * has no children of its own, so Left instead moves focus to its owning Project heading: only a Project is a
 * collapse/expand target, and Right on one of those rows does nothing.
 *
 * Right on an already expanded Project used to be a dead key, which is the half of the pattern that leaves a user who
 * opened a Project with the arrow keys no way to continue into it with the same key.
 */
export function primarySidebarHorizontalIntent(
    rows: readonly PrimarySidebarTreeRow[],
    row: PrimarySidebarTreeRow,
    isExpanded: boolean,
    key: 'ArrowLeft' | 'ArrowRight',
): PrimarySidebarHorizontalIntent {
    if (row.kind !== 'project') return key === 'ArrowLeft' ? { focusRowId: row.projectId } : {};
    if (key === 'ArrowLeft') return isExpanded ? { expanded: false } : {};
    if (!isExpanded) return { expanded: true };
    const firstChildRowId = firstPrimarySidebarChildRowId(rows, row);
    return firstChildRowId ? { focusRowId: firstChildRowId } : {};
}

/**
 * Resolves which row owns the PrimarySidebar tree's single roving Tab stop (standard ARIA tree authoring pattern: one
 * Tab stop, arrow keys move focus inside it). Prefers the last row the user actually focused, but that id can go stale
 * (a Session gets archived, or a Project collapses over the Session that was focused) so it falls back through the
 * selected Session's row, then the selected Project's heading row, then the first row, exactly like a fresh tree with
 * no focus history yet.
 */
export function rovingPrimarySidebarRowId(
    rows: readonly PrimarySidebarTreeRow[],
    focusedRowId: string | undefined,
    selectedSessionId: string | undefined,
    selectedProjectId: string | undefined,
): string | undefined {
    if (focusedRowId && rows.some((row) => row.id === focusedRowId)) return focusedRowId;
    if (selectedSessionId && rows.some((row) => row.id === selectedSessionId))
        return selectedSessionId;
    /**
     * A pinned Session whose own Project group is collapsed still has a row on screen, in the Pinned group. Reaching
     * for it before falling back to the Project heading keeps the Tab stop on the selected Session whenever any row for
     * it exists.
     */
    const pinnedRowId = selectedSessionId && primarySidebarPinnedRowId(selectedSessionId);
    if (pinnedRowId && rows.some((row) => row.id === pinnedRowId)) return pinnedRowId;
    if (selectedProjectId && rows.some((row) => row.id === selectedProjectId))
        return selectedProjectId;
    return rows[0]?.id;
}

export type PrimarySidebarRowKeyIntent = 'archive';

/**
 * Resolves Delete/Backspace on a focused tree row to the archive intent. Only a Session row has an archive action, so a
 * Project, reveal, or "New Session" row (or any other key) resolves to no intent; the caller is responsible for the
 * actual `archiveSession` side effect (archiving is reversible via the Archived Sessions dialog, so this intentionally
 * skips a confirmation step).
 */
export function primarySidebarArchiveIntent(
    row: PrimarySidebarTreeRow,
    key: string,
): PrimarySidebarRowKeyIntent | undefined {
    if (row.kind !== 'session') return undefined;
    return key === 'Delete' || key === 'Backspace' ? 'archive' : undefined;
}

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
     * The owning Project id; equals `id` itself for a Project row.
     */
    projectId: string;
}

/**
 * Row id of a Project's "show more Sessions" row. Namespaced so it can never collide with a Session id.
 */
export function primarySidebarRevealRowId(projectId: string): string {
    return `reveal-sessions:${projectId}`;
}

const CREATE_SESSION_ROW_PREFIX = 'create-session:';

/**
 * Row id of the "New Session" row a Project with no Sessions shows in place of its Session list. Namespaced like the
 * reveal row so it can never collide with a Session id.
 */
export function primarySidebarCreateSessionRowId(projectId: string): string {
    return `${CREATE_SESSION_ROW_PREFIX}${projectId}`;
}

export function isPrimarySidebarCreateSessionRowId(rowId: string | undefined): boolean {
    return rowId?.startsWith(CREATE_SESSION_ROW_PREFIX) ?? false;
}

/**
 * Flattens the PrimarySidebar into the exact row order arrow-key navigation should walk: each Project heading, followed
 * by its visible Sessions and its reveal row while that Project is expanded. Matches `DisclosureMotion`'s collapsed
 * state and the Session window exactly so focus never lands on a hidden row.
 *
 * An expanded Project with no visible Sessions renders the "New Session" row in place of that list, so it takes the
 * Session rows' place here too. The condition is read straight off `sessionIds` rather than a separate emptiness flag:
 * `ProjectGroup` renders that row on exactly the same test, and two sources of truth for one row would eventually
 * disagree and put focus on a row that is not on screen.
 */
export function flattenPrimarySidebarRows(
    projects: readonly PrimarySidebarProjectNode[],
    isExpanded: (projectId: string) => boolean,
): PrimarySidebarTreeRow[] {
    const rows: PrimarySidebarTreeRow[] = [];
    for (const project of projects) {
        rows.push({ id: project.id, kind: 'project', projectId: project.id });
        if (!isExpanded(project.id)) continue;
        for (const sessionId of project.sessionIds)
            rows.push({ id: sessionId, kind: 'session', projectId: project.id });
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
 * Resolves Left/Right on a tree row per the standard ARIA tree authoring pattern: Right opens a collapsed Project, Left
 * closes an open one. A Session, reveal, or "New Session" row has no children of its own, so Left instead moves focus
 * to its owning Project heading — only a Project is a collapse/expand target.
 */
export function primarySidebarHorizontalIntent(
    row: PrimarySidebarTreeRow,
    isExpanded: boolean,
    key: 'ArrowLeft' | 'ArrowRight',
): PrimarySidebarHorizontalIntent {
    if (row.kind !== 'project') return key === 'ArrowLeft' ? { focusRowId: row.projectId } : {};
    if (key === 'ArrowRight') return isExpanded ? {} : { expanded: true };
    return isExpanded ? { expanded: false } : {};
}

/**
 * Resolves which row owns the PrimarySidebar tree's single roving Tab stop (standard ARIA tree authoring pattern: one
 * Tab stop, arrow keys move focus inside it). Prefers the last row the user actually focused, but that id can go stale
 * — a Session gets archived, or a Project collapses over the Session that was focused — so it falls back through the
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

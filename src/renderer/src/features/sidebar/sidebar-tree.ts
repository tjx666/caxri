/**
 * Pure row-order and arrow-key math for the Sidebar's ARIA tree. Kept separate from
 * `ProjectGroup`/`ProjectSidebar` so the navigation logic is covered by fast unit tests instead of
 * an Electron E2E workflow (see AGENTS.md: extract logic into a pure function and test that).
 */

export interface SidebarProjectNode {
    id: string;
    sessionIds: readonly string[];
}

export interface SidebarTreeRow {
    id: string;
    kind: 'project' | 'session';
    /** The owning Project id; equals `id` itself for a Project row. */
    projectId: string;
}

/**
 * Flattens the Sidebar into the exact row order arrow-key navigation should walk: each Project
 * heading, followed by its active Sessions while that Project is expanded. Matches
 * `DisclosureMotion`'s collapsed state exactly so focus never lands on a hidden row.
 */
export function flattenSidebarRows(
    projects: readonly SidebarProjectNode[],
    isExpanded: (projectId: string) => boolean,
): SidebarTreeRow[] {
    const rows: SidebarTreeRow[] = [];
    for (const project of projects) {
        rows.push({ id: project.id, kind: 'project', projectId: project.id });
        if (!isExpanded(project.id)) continue;
        for (const sessionId of project.sessionIds)
            rows.push({ id: sessionId, kind: 'session', projectId: project.id });
    }
    return rows;
}

export type SidebarVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

/**
 * Returns the row id roving focus should move to for Up/Down/Home/End, or `undefined` when the key
 * does not move focus (empty tree, or already at an edge).
 */
export function nextSidebarRowId(
    rows: readonly SidebarTreeRow[],
    activeRowId: string | undefined,
    key: SidebarVerticalKey,
): string | undefined {
    if (rows.length === 0) return undefined;
    if (key === 'Home') return rows[0]?.id;
    if (key === 'End') return rows[rows.length - 1]?.id;
    const currentIndex = rows.findIndex((row) => row.id === activeRowId);
    if (currentIndex < 0) return rows[0]?.id;
    const nextIndex = currentIndex + (key === 'ArrowDown' ? 1 : -1);
    return nextIndex >= 0 && nextIndex < rows.length ? rows[nextIndex]?.id : undefined;
}

export interface SidebarHorizontalIntent {
    /** Present when Left/Right should flip a Project's expanded state. */
    expanded?: boolean;
    /** Present when Left/Right should move roving focus to a different row. */
    focusRowId?: string;
}

/**
 * Resolves Left/Right on a tree row per the standard ARIA tree authoring pattern: Right opens a
 * collapsed Project, Left closes an open one. A Session has no children of its own, so Left instead
 * moves focus to its owning Project heading — Sessions are never collapse/expand targets themselves.
 */
export function sidebarHorizontalIntent(
    row: SidebarTreeRow,
    expanded: boolean,
    key: 'ArrowLeft' | 'ArrowRight',
): SidebarHorizontalIntent {
    if (row.kind === 'session') return key === 'ArrowLeft' ? { focusRowId: row.projectId } : {};
    if (key === 'ArrowRight') return expanded ? {} : { expanded: true };
    return expanded ? { expanded: false } : {};
}

/**
 * Resolves which row owns the Sidebar tree's single roving Tab stop (standard ARIA tree
 * authoring pattern: one Tab stop, arrow keys move focus inside it). Prefers the last row the
 * user actually focused, but that id can go stale — a Session gets archived, or a Project
 * collapses over the Session that was focused — so it falls back through the selected Session's
 * row, then the selected Project's heading row, then the first row, exactly like a fresh tree
 * with no focus history yet.
 */
export function rovingSidebarRowId(
    rows: readonly SidebarTreeRow[],
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

export type SidebarRowKeyIntent = 'archive';

/**
 * Resolves Delete/Backspace on a focused tree row to the archive intent. Only a Session row has an
 * archive action, so a Project row (or any other key) resolves to no intent; the caller is
 * responsible for the actual `archiveSession` side effect (archiving is reversible via the
 * Archived Sessions dialog, so this intentionally skips a confirmation step).
 */
export function sidebarArchiveIntent(
    row: SidebarTreeRow,
    key: string,
): SidebarRowKeyIntent | undefined {
    if (row.kind !== 'session') return undefined;
    return key === 'Delete' || key === 'Backspace' ? 'archive' : undefined;
}

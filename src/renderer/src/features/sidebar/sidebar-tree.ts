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

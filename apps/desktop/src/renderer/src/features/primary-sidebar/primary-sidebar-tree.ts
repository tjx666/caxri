/**
 * Pure row-order and arrow-key math for the PrimarySidebar's ARIA tree. Kept separate from
 * `ProjectGroup`/`PrimarySidebar` so the navigation logic is covered by fast unit tests instead of an Electron E2E
 * workflow (see the `unit-testing` skill).
 */

import type { TreeNavigation, TreeRowModel, TreeVerticalKey } from '../../lib/tree-navigation';
import { treeNavigationTarget, treeVerticalTargetId } from '../../lib/tree-navigation';

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
    /**
     * Index in `sessionIds` the `Show fewer` row precedes (`SessionListWindow.showFewerIndex`); absent when the window
     * was never revealed past its default rows.
     */
    showFewerIndex?: number;
}

export interface PrimarySidebarTreeRow {
    id: string;
    /**
     * `subagent` and `subagentMore` rows sit one level under their Session row: a Chat's subagent, and the row that
     * shows the rest of that Chat's subagents (or folds them again). `delegatedSession` and `delegatedReveal` sit at
     * the same level under their host Session row: a Session the host delegated work to, and the row that shows the
     * rest of the host's settled ones.
     */
    kind:
        | 'project'
        | 'session'
        | 'reveal'
        | 'showFewer'
        | 'createSession'
        | 'subagent'
        | 'subagentMore'
        | 'delegatedSession'
        | 'delegatedReveal';
    /**
     * The owning group's heading row id; equals `id` itself for a Project row, and `PINNED_GROUP_ROW_ID` for everything
     * inside the Pinned group. Named for the Project because that is what it is everywhere except that one group.
     */
    projectId: string;
    /**
     * The Session this row acts on: the Session of a `session` or `delegatedSession` row, and the host Session of a
     * `subagent`, `subagentMore`, or `delegatedReveal` row. Distinct from `id` because a row inside the Pinned group
     * (and a nested one) carries a namespaced row id rather than the Session id; every action still has to reach the
     * Session itself.
     */
    sessionId?: string;
    /**
     * The Session row a `subagent`, `subagentMore`, `delegatedSession`, or `delegatedReveal` row nests under, which
     * Left returns to. Its own id rather than a Session id because a pinned Session's row carries a namespaced one.
     */
    parentRowId?: string;
    /**
     * The Chat Terminal and task a `subagent` row opens.
     */
    terminalId?: string;
    taskId?: string;
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
 * Row id of the row that folds a revealed Project (or Pinned) group back to its default rows. Namespaced like the
 * reveal row so it can never collide with a Session id.
 */
export function primarySidebarShowFewerRowId(projectId: string): string {
    return `show-fewer-sessions:${projectId}`;
}

/**
 * Row id of the "New Session" row a Project with no Sessions shows in place of its Session list. Namespaced like the
 * reveal row so it can never collide with a Session id.
 */
export function primarySidebarCreateSessionRowId(projectId: string): string {
    return `create-session:${projectId}`;
}

/**
 * Row id of one subagent row. A Session lists the subagents of one Chat, so the Session id plus the task id is unique,
 * and the Session id lets a row list tell cheaply whether the roving row is its own.
 */
export function primarySidebarSubagentRowId(sessionId: string, taskId: string): string {
    return `subagent:${sessionId}:${taskId}`;
}

/**
 * Row id of the row that shows the rest of a Session's subagents, or folds them again. Namespaced like the reveal row.
 */
export function primarySidebarSubagentMoreRowId(sessionId: string): string {
    return `subagent-more:${sessionId}`;
}

/**
 * Row id of a nested Session's row under its host. Namespaced because a Session has exactly one row, and this one says
 * it is a child: `focusRow`'s `[data-row-id]` lookup, the roving Tab stop, and the selection fallback address it by
 * this id, while every action still goes through the row's `sessionId`.
 */
export function primarySidebarDelegatedRowId(sessionId: string): string {
    return `delegated-session:${sessionId}`;
}

/**
 * Row id of the row that shows the rest of a host's nested Sessions. Keyed by the host Session id, which owns exactly
 * one such row.
 */
export function primarySidebarDelegatedRevealRowId(hostSessionId: string): string {
    return `reveal-delegated:${hostSessionId}`;
}

/**
 * The nested Sessions one host shows under it, already ordered and windowed (see `delegated-child-window.ts`).
 */
export interface PrimarySidebarDelegatedNode {
    /**
     * True when the host's child window hides at least one settled nested Session, which is what puts its reveal row on
     * screen.
     */
    hasHiddenSessions?: boolean;
    /**
     * The nested Sessions the window actually renders, in display order.
     */
    sessionIds: readonly string[];
}

/**
 * The subagent rows one Session shows under it, already ordered and windowed (see `session-subagents.ts`).
 */
export interface PrimarySidebarSubagentNode {
    /**
     * Where the show-more/show-fewer row sits: before the task at this index of `taskIds`. Absent when the Session has
     * no more subagents than the collapsed window.
     */
    toggleIndex?: number;
    /**
     * The Session's rendered subagents, in display order.
     */
    taskIds: readonly string[];
    terminalId: string;
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
    /**
     * Index in `sessionIds` the `Show fewer` row precedes; absent when the window was never revealed past its default.
     */
    showFewerIndex?: number;
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
 * A Session that shows subagents (`subagents`, keyed by Session id) follows its own row with their rows and, when it
 * has more than the collapsed window, the show-more row right after the first few, one level deeper than the Session. A
 * host Session that shows nested Sessions (`delegated`, keyed by host Session id) then follows with their rows and,
 * when its child window hides some, the reveal row, at the same depth, so Right on a host steps into its subagents
 * first. Nested Sessions are never hosts themselves and show no subagent rows: a delegation chain flattens onto one
 * level.
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
    subagents?: ReadonlyMap<string, PrimarySidebarSubagentNode>,
    delegated?: ReadonlyMap<string, PrimarySidebarDelegatedNode>,
): PrimarySidebarTreeRow[] {
    const rows: PrimarySidebarTreeRow[] = [];
    /**
     * A host's nested Session rows follow its subagent rows, one level deeper, closed by the reveal row when the child
     * window hides some. The host's row id is passed in because a pinned Session's differs from its id.
     */
    const pushDelegatedRows = (
        hostSessionId: string,
        hostRowId: string,
        projectId: string,
    ): void => {
        const node = delegated?.get(hostSessionId);
        if (!node) return;
        for (const sessionId of node.sessionIds)
            rows.push({
                id: primarySidebarDelegatedRowId(sessionId),
                kind: 'delegatedSession',
                parentRowId: hostRowId,
                projectId,
                sessionId,
            });
        if (node.hasHiddenSessions)
            rows.push({
                id: primarySidebarDelegatedRevealRowId(hostSessionId),
                kind: 'delegatedReveal',
                parentRowId: hostRowId,
                projectId,
                sessionId: hostSessionId,
            });
    };
    /**
     * A Session's subagent rows follow its own row, one level deeper. The Session's row id is passed in because a
     * pinned Session's differs from its id.
     */
    const pushSubagentRows = (sessionId: string, sessionRowId: string, projectId: string): void => {
        const node = subagents?.get(sessionId);
        if (!node) return;
        const pushToggle = (): void => {
            rows.push({
                id: primarySidebarSubagentMoreRowId(sessionId),
                kind: 'subagentMore',
                parentRowId: sessionRowId,
                projectId,
                sessionId,
            });
        };
        for (const [index, taskId] of node.taskIds.entries()) {
            if (index === node.toggleIndex) pushToggle();
            rows.push({
                id: primarySidebarSubagentRowId(sessionId, taskId),
                kind: 'subagent',
                parentRowId: sessionRowId,
                projectId,
                sessionId,
                taskId,
                terminalId: node.terminalId,
            });
        }
        if (node.toggleIndex === node.taskIds.length) pushToggle();
    };
    /**
     * The fold row sits among the Session rows, right after the default ones, at the same depth as them. It is only
     * pushed ahead of a following Session row, so a boundary with nothing after it adds no row.
     */
    const pushShowFewer = (groupId: string): void => {
        rows.push({
            id: primarySidebarShowFewerRowId(groupId),
            kind: 'showFewer',
            projectId: groupId,
        });
    };
    if (pinned && pinned.sessionIds.length > 0) {
        rows.push({
            id: PINNED_GROUP_ROW_ID,
            kind: 'project',
            projectId: PINNED_GROUP_ROW_ID,
        });
        if (pinned.expanded) {
            for (const [index, sessionId] of pinned.sessionIds.entries()) {
                if (index === pinned.showFewerIndex) pushShowFewer(PINNED_GROUP_ROW_ID);
                rows.push({
                    id: primarySidebarPinnedRowId(sessionId),
                    kind: 'session',
                    projectId: PINNED_GROUP_ROW_ID,
                    sessionId,
                });
                const rowId = primarySidebarPinnedRowId(sessionId);
                pushSubagentRows(sessionId, rowId, PINNED_GROUP_ROW_ID);
                pushDelegatedRows(sessionId, rowId, PINNED_GROUP_ROW_ID);
            }
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
        for (const [index, sessionId] of project.sessionIds.entries()) {
            if (index === project.showFewerIndex) pushShowFewer(project.id);
            rows.push({ id: sessionId, kind: 'session', projectId: project.id, sessionId });
            pushSubagentRows(sessionId, sessionId, project.id);
            pushDelegatedRows(sessionId, sessionId, project.id);
        }
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

/**
 * Project (and Pinned) headings sit at the top level, their Session, reveal, and "New Session" rows one level in, and
 * the rows under a Session (its subagents, its nested Sessions and their reveal row) one level further.
 */
const primarySidebarRowModel: TreeRowModel<PrimarySidebarTreeRow> = {
    depthOf: (row) => {
        switch (row.kind) {
            case 'project': {
                return 0;
            }
            case 'subagent':
            case 'subagentMore':
            case 'delegatedSession':
            case 'delegatedReveal': {
                return 2;
            }
            default: {
                return 1;
            }
        }
    },
};

/**
 * Returns the row id roving focus should move to for Up/Down/Home/End, or `undefined` when the key does not move focus
 * (empty tree, or already at an edge).
 */
export function nextPrimarySidebarRowId(
    rows: readonly PrimarySidebarTreeRow[],
    activeRowId: string | undefined,
    key: TreeVerticalKey,
): string | undefined {
    return treeVerticalTargetId(rows, activeRowId, key, primarySidebarRowModel);
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
 * Resolves Left/Right on a tree row per the standard ARIA tree authoring pattern: Right opens a collapsed Project and
 * steps into the first row of an already open one, Left closes an open Project. Any other row is not a collapse/expand
 * target (a host's nested Sessions are always listed), so Left moves focus to its parent row (a Session, reveal, or
 * "New Session" row goes to its Project heading; a subagent, nested Session, or nested reveal row goes to its host
 * Session row) and Right steps into the row's first child, which only a Session row that lists subagents or nested
 * Sessions has. Right on a row without children does nothing.
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
    const index = rows.findIndex((candidate) => candidate.id === row.id);
    const targetId = (action: TreeNavigation): string | undefined => {
        const target = treeNavigationTarget(rows, index, action, primarySidebarRowModel);
        return target === undefined ? undefined : rows[target].id;
    };
    if (row.kind !== 'project') {
        const targetRowId = targetId(key === 'ArrowLeft' ? 'parent' : 'firstChild');
        return targetRowId ? { focusRowId: targetRowId } : {};
    }
    if (key === 'ArrowLeft') return isExpanded ? { expanded: false } : {};
    if (!isExpanded) return { expanded: true };
    const firstChildId = targetId('firstChild');
    return firstChildId ? { focusRowId: firstChildId } : {};
}

/**
 * Resolves which row owns the PrimarySidebar tree's single roving Tab stop (standard ARIA tree authoring pattern: one
 * Tab stop, arrow keys move focus inside it). Prefers the last row the user actually focused, but that id can go stale
 * (a Session gets archived, or a Project collapses over the Session that was focused) so it falls back through the
 * selected Session's row (in its Project, the Pinned group, or under its host), then the first of
 * `selectedFallbackRowIds` that is on screen, then the selected Project's heading row, then the first row, exactly like
 * a fresh tree with no focus history yet.
 *
 * `selectedFallbackRowIds` is for a selected Session that has no row of its own right now, in preference order. A
 * nested Session whose host is collapsed away passes its host row and then its host's group heading, so the Tab stop
 * lands where the Session lives rather than on a Project it does not belong to.
 */
export function rovingPrimarySidebarRowId(
    rows: readonly PrimarySidebarTreeRow[],
    focusedRowId: string | undefined,
    selectedSessionId: string | undefined,
    selectedProjectId: string | undefined,
    selectedFallbackRowIds: readonly string[] = [],
): string | undefined {
    const hasRow = (rowId: string): boolean => rows.some((row) => row.id === rowId);
    if (focusedRowId && hasRow(focusedRowId)) return focusedRowId;
    if (selectedSessionId) {
        /**
         * A pinned Session whose own Project group is collapsed still has a row on screen, in the Pinned group.
         * Reaching for it before falling back to the Project heading keeps the Tab stop on the selected Session
         * whenever any row for it exists. A nested Session's row is likewise addressed by its own namespaced id.
         */
        const sessionRowId = [
            selectedSessionId,
            primarySidebarPinnedRowId(selectedSessionId),
            primarySidebarDelegatedRowId(selectedSessionId),
        ].find(hasRow);
        if (sessionRowId) return sessionRowId;
    }
    const fallbackRowId = selectedFallbackRowIds.find(hasRow);
    if (fallbackRowId) return fallbackRowId;
    if (selectedProjectId && hasRow(selectedProjectId)) return selectedProjectId;
    return rows[0]?.id;
}

export type PrimarySidebarRowKeyIntent = 'archive';

/**
 * Resolves Delete/Backspace on a focused tree row to the archive intent. Only a Session row, top-level or nested, has
 * an archive action, so a Project, reveal, subagent, or "New Session" row (or any other key) resolves to no intent; the
 * caller is responsible for the actual `archiveSession` side effect (archiving is reversible via the Archived Sessions
 * dialog, so it asks only when the Agent is still working; see `archiveSession`).
 */
export function primarySidebarArchiveIntent(
    row: PrimarySidebarTreeRow,
    key: string,
): PrimarySidebarRowKeyIntent | undefined {
    if (row.kind !== 'session' && row.kind !== 'delegatedSession') return undefined;
    return key === 'Delete' || key === 'Backspace' ? 'archive' : undefined;
}

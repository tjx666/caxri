import type { CSSProperties, FocusEvent, KeyboardEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import caxriLogoUrl from '../../assets/caxri-logo.png';
import { executeCommand } from '../../commands/execute';
import { usePolledQuery } from '../../hooks/use-polled-query';
import {
    useIsFullScreen,
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useSettings,
    useTerminals,
} from '../../stores/selectors';
import {
    archiveSession,
    beginSessionCreation,
    canResumeAutomaticSessionNaming,
    resumeAutomaticSessionNaming,
} from '../session/session-actions';
import { activeSessionsInSidebarOrder } from '../session/session-activity-order';
import { useProjectCollapse } from './hooks/use-project-collapse';
import type { PrimarySidebarVerticalKey } from './primary-sidebar-tree';
import {
    flattenPrimarySidebarRows,
    nextPrimarySidebarRowId,
    primarySidebarArchiveIntent,
    primarySidebarHorizontalIntent,
    rovingPrimarySidebarRowId,
} from './primary-sidebar-tree';
import { ProjectGroup } from './project-group';
import { hasProjectDragType } from './project-order';
import { SessionHistoryNavigation } from './session-history-navigation';
import {
    nextRevealedSessionCount,
    SESSION_REVEAL_STEP,
    sessionListWindow,
} from './session-list-window';

const PRIMARY_SIDEBAR_VERTICAL_KEYS: readonly PrimarySidebarVerticalKey[] = [
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
];

function isPrimarySidebarVerticalKey(key: string): key is PrimarySidebarVerticalKey {
    return (PRIMARY_SIDEBAR_VERTICAL_KEYS as readonly string[]).includes(key);
}
import { useProjectOrder } from './hooks/use-project-order';
import { useSessionRename } from './hooks/use-session-rename';

const NO_RECORDS: never[] = [];
/**
 * The Server sweep owns delivery-CLI pacing per Session; this poll only asks for the latest projection, and the
 * `sessionPullRequests.changed` event refetches early when a sweep changes something.
 */
const SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS = 60_000;
/**
 * Vite serves this repo-only asset in development without bundling it into production.
 */
const primarySidebarLogoUrl = import.meta.env.DEV ? '/src/assets/caxri-logo-dev.png' : caxriLogoUrl;
const onAddProject = (): void => executeCommand('project.create');

export function PrimarySidebar() {
    const loadedProjects = useProjects();
    const projects = loadedProjects ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const isFullScreen = useIsFullScreen();
    const autoCollapseSetting = useSettings()?.['primarySidebar.autoCollapseProjects'] ?? 'off';
    const selectedProjectId = useSelectedProject()?.id;
    const selectedSessionId = useSelectedSession()?.id;
    const projectOrder = useProjectOrder(projects);
    const projectCollapse = useProjectCollapse({
        autoCollapseSetting,
        projects: loadedProjects,
        selectedSessionId,
        sessions,
    });
    const [animatedProjectIds, setAnimatedProjectIds] = useState<Set<string>>(() => new Set());
    /**
     * How many Sessions each Project has revealed beyond the default window, keyed by Project id. Deliberately kept in
     * memory only: a relaunch should start from the short list again, the same way it starts scrolled to the top.
     */
    const [revealedSessionCounts, setRevealedSessionCounts] = useState<Record<string, number>>({});
    /**
     * The last tree row the user actually focused; feeds `rovingPrimarySidebarRowId`'s roving-tabindex resolution.
     */
    const [focusedRowId, setFocusedRowId] = useState<string>();
    const treeReference = useRef<HTMLDivElement>(null);
    const sessionRename = useSessionRename(sessions);
    const pullRequests = usePolledQuery('session.pullRequests', undefined, {
        label: 'session.pullRequests',
        intervalMs: SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
    }).data?.pullRequests;
    const sidebarSessions = useMemo(
        () => activeSessionsInSidebarOrder(projects, sessions),
        [projects, sessions],
    );

    const isProjectExpanded = projectCollapse.isProjectExpanded;

    /**
     * One windowed Session list per Project, in sidebar order. Shared by the flattened tree rows and the rendered
     * groups so arrow-key navigation can never reach a Session the window hides.
     */
    const projectWindows = useMemo(
        () =>
            projects.map((project) => {
                // Single pass instead of `.filter().map()`: react-doctor's combine-iterations rule
                // flags the chained form even though both walk the same small `sessions` array.
                const projectSessions: SessionRecord[] = [];
                for (const session of sidebarSessions)
                    if (session.projectId === project.id) projectSessions.push(session);
                return {
                    project,
                    ...sessionListWindow(
                        projectSessions,
                        revealedSessionCounts[project.id],
                        selectedSessionId,
                    ),
                };
            }),
        [projects, revealedSessionCounts, selectedSessionId, sidebarSessions],
    );

    /**
     * Flattened row order that Up/Down/Home/End walk; recomputed only when the tree's shape changes.
     */
    const treeRows = useMemo(
        () =>
            flattenPrimarySidebarRows(
                projectWindows.map((entry) => ({
                    hasHiddenSessions: entry.hiddenCount > 0,
                    id: entry.project.id,
                    sessionIds: entry.visibleSessions.map((session) => session.id),
                })),
                isProjectExpanded,
            ),
        [projectWindows, isProjectExpanded],
    );

    /**
     * The single row that owns the tree's roving Tab stop (standard ARIA tree authoring pattern). Falls back through
     * the selected Session, then the selected Project, then the first row whenever `focusedRowId` is unset or has gone
     * stale (archived Session, collapsed Project).
     */
    const rovingRowId = useMemo(
        () =>
            rovingPrimarySidebarRowId(treeRows, focusedRowId, selectedSessionId, selectedProjectId),
        [treeRows, focusedRowId, selectedSessionId, selectedProjectId],
    );

    const handleTreeFocus = useCallback((event: FocusEvent<HTMLDivElement>): void => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const rowId = target.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
        if (rowId) setFocusedRowId(rowId);
    }, []);

    const toggleProject = (projectId: string): void => {
        setAnimatedProjectIds((current) => new Set(current).add(projectId));
        projectCollapse.toggleProject(projectId);
    };

    const focusRow = (rowId: string): void => {
        treeReference.current
            ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
            ?.focus();
    };

    /**
     * Steps a Project's Session window forward. The next window is measured from what is on screen right now, so it
     * always adds exactly the number the reveal row promised — even when the selected-Session guarantee already widened
     * it past the stored count.
     */
    const revealMoreSessions = (
        projectId: string,
        visibleSessions: readonly SessionRecord[],
        hiddenCount: number,
    ): void => {
        setRevealedSessionCounts((current) => ({
            ...current,
            [projectId]: nextRevealedSessionCount(visibleSessions.length),
        }));
        // The final step unmounts the reveal row itself, which would drop the tree's roving Tab stop onto the document
        // body. Hand focus to the Session row directly above it while that row still exists — the same pre-unmount
        // handoff the Delete/Backspace archive path performs.
        const lastVisibleSessionId = visibleSessions.at(-1)?.id;
        if (lastVisibleSessionId && hiddenCount <= SESSION_REVEAL_STEP)
            focusRow(lastVisibleSessionId);
    };

    /**
     * The PrimarySidebar tree is a single roving Tab stop (standard ARIA tree authoring pattern): only the row in
     * `rovingRowId` is a Tab stop, and every inner control (disclosure, "New Session", archived-count, per-row Archive)
     * is `tabIndex={-1}`. This handler supplies the keyboard equivalents that stop being reachable by Tab:
     *
     * - Up/Down/Home/End walk every Project heading and its active Sessions.
     * - Left/Right expand/collapse a Project, or move a Session row to its owning Project.
     * - R resumes automatic naming for a stopped Session.
     * - Delete/Backspace on a focused Session row archives it (reversible via the Archived Sessions dialog, so no
     *   confirmation) — the keyboard equivalent of the Archive button. Focus moves to the next row (falling back to the
     *   previous row when the archived row was last) before the row leaves the DOM, so the roving Tab stop never falls
     *   out of the tree.
     */
    const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.closest('input, textarea')) return;
        const rowElement = target.closest<HTMLElement>('[data-row-id]');
        const rowId = rowElement?.dataset.rowId;
        if (!rowId) return;
        if (isPrimarySidebarVerticalKey(event.key)) {
            const nextRowId = nextPrimarySidebarRowId(treeRows, rowId, event.key);
            if (!nextRowId) return;
            event.preventDefault();
            focusRow(nextRowId);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const row = treeRows.find((item) => item.id === rowId);
            if (!row) return;
            const intent = primarySidebarHorizontalIntent(
                row,
                isProjectExpanded(row.projectId),
                event.key,
            );
            if (intent.expanded !== undefined) {
                event.preventDefault();
                toggleProject(row.projectId);
            }
            if (intent.focusRowId) {
                event.preventDefault();
                focusRow(intent.focusRowId);
            }
            return;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            const row = treeRows.find((item) => item.id === rowId);
            if (!row) return;
            if (primarySidebarArchiveIntent(row, event.key) === 'archive') {
                event.preventDefault();
                // Compute where focus lands before the row leaves the DOM: the Project heading is
                // always above a Session row, so the ArrowUp fallback never comes up empty here.
                const focusAfterArchive =
                    nextPrimarySidebarRowId(treeRows, rowId, 'ArrowDown') ??
                    nextPrimarySidebarRowId(treeRows, rowId, 'ArrowUp');
                archiveSession(row.id);
                if (focusAfterArchive) focusRow(focusAfterArchive);
            }
            return;
        }
        if (event.key.toLowerCase() === 'r') {
            const row = treeRows.find((item) => item.id === rowId);
            const session =
                row?.kind === 'session' ? sessions.find((item) => item.id === row.id) : undefined;
            if (
                session &&
                canResumeAutomaticSessionNaming(
                    session,
                    terminals.find((item) => item.id === session.primaryAgentTerminalId),
                )
            ) {
                event.preventDefault();
                resumeAutomaticSessionNaming(session.id);
            }
        }
    };

    return (
        <aside className="session-primary-sidebar flex min-w-0 flex-col bg-surface">
            <div
                className={`primary-sidebar-title flex h-11 items-center py-0 pr-2 font-semibold ${isFullScreen ? 'pl-3' : 'pl-[84px]'}`}
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
                {isFullScreen && (
                    /**
                     * MacOS hides the traffic lights in fullscreen, leaving the reserved `pl-[84px]` gap empty. Show
                     * the logo instead so the primarySidebar header keeps a left-side anchor; `data-caxri-logo` also
                     * lets e2e assert it only exists here.
                     */
                    <img
                        src={primarySidebarLogoUrl}
                        alt="Caxri"
                        className="mr-2 h-7 w-7 object-contain"
                        data-caxri-logo
                    />
                )}
                <SessionHistoryNavigation />
            </div>
            <div
                ref={treeReference}
                aria-label="Primary Side Bar"
                className="project-list min-h-0 flex-1 overflow-auto p-2"
                role="tree"
                onDragOver={(event) => {
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    projectOrder.onListDragOver(event);
                }}
                onFocusCapture={handleTreeFocus}
                onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                        projectCollapse.setHasFocus(false);
                }}
                onFocus={() => projectCollapse.setHasFocus(true)}
                onKeyDown={handleTreeKeyDown}
                onPointerEnter={() => projectCollapse.setIsHovered(true)}
                onPointerLeave={() => projectCollapse.setIsHovered(false)}
            >
                {projectWindows.map(
                    ({ hiddenCount, nextRevealCount, project, visibleSessions }) => (
                        <ProjectGroup
                            key={project.id}
                            active={project.id === selectedProjectId}
                            animateProject={animatedProjectIds.has(project.id)}
                            dragged={projectOrder.draggedProjectId === project.id}
                            expanded={isProjectExpanded(project.id)}
                            focusRenameInput={sessionRename.focusRenameInput}
                            hiddenSessionCount={hiddenCount}
                            nextRevealCount={nextRevealCount}
                            onBeginRename={sessionRename.beginRename}
                            onBlurRename={sessionRename.blurRename}
                            onCancelRename={sessionRename.cancelRename}
                            onCommitRename={sessionRename.commitRename}
                            onCreateSession={() => beginSessionCreation(project.id)}
                            onDragEnd={projectOrder.endDrag}
                            onDragOver={(event) => projectOrder.updateDropTarget(event, project.id)}
                            onDragStart={(event) => projectOrder.startDrag(event, project.id)}
                            onDrop={(event) => projectOrder.drop(event, project.id)}
                            onMove={(delta) =>
                                projectOrder.move(project.id, project.displayTitle, delta)
                            }
                            onRenameValueChange={sessionRename.onRenameValueChange}
                            onRevealMoreSessions={() =>
                                revealMoreSessions(project.id, visibleSessions, hiddenCount)
                            }
                            onToggle={() => toggleProject(project.id)}
                            project={project}
                            pullRequests={pullRequests}
                            projectDropTarget={
                                projectOrder.projectDropTarget?.projectId === project.id
                                    ? projectOrder.projectDropTarget
                                    : undefined
                            }
                            renameError={sessionRename.renameError}
                            renameValue={sessionRename.renameValue}
                            renamingSessionId={sessionRename.renamingSessionId}
                            rovingRowId={rovingRowId}
                            selectedSessionId={selectedSessionId}
                            terminals={terminals}
                            visibleSessions={visibleSessions}
                        />
                    ),
                )}
                {projects.length === 0 && (
                    <button
                        className="first-session flex min-h-[72px] w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border bg-transparent p-4 text-muted hover:border-muted hover:text-foreground"
                        onClick={onAddProject}
                    >
                        <Plus size={16} /> Add your first Project
                    </button>
                )}
                <div className="project-order-announcement sr-only" aria-live="polite">
                    {projectOrder.projectOrderAnnouncement}
                </div>
            </div>
        </aside>
    );
}

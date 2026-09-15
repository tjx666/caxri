import type { FocusEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';

import type { ProjectRecord } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import {
    useIsFullScreen,
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useSettings,
    useTerminals,
} from '../../stores/selectors';
import { activeSessionsInSidebarOrder } from '../session/session-activity-order';
import { useCreateSessionRowFocus } from './hooks/use-create-session-row-focus';
import { useProjectCollapse } from './hooks/use-project-collapse';
import { useProjectOrder } from './hooks/use-project-order';
import type { ProjectSessionWindow } from './hooks/use-project-session-windows';
import { useProjectSessionWindows } from './hooks/use-project-session-windows';
import { useSessionOrder } from './hooks/use-session-order';
import { useSessionPullRequestPoll } from './hooks/use-session-pull-request';
import { useSessionRename } from './hooks/use-session-rename';
import { PrimarySidebarFooter } from './primary-sidebar-footer';
import { PrimarySidebarHeader } from './primary-sidebar-header';
import { flattenPrimarySidebarRows, rovingPrimarySidebarRowId } from './primary-sidebar-tree';
import { handlePrimarySidebarTreeKey } from './primary-sidebar-tree-keys';
import { ProjectGroup } from './project-group';
import { hasProjectDragType } from './project-order';
import { sessionWorktreeProject, topLevelProjects } from './project-visibility';
import { SESSION_REVEAL_STEP } from './session-list-window';

const NO_RECORDS: never[] = [];
const onAddProject = (): void => executeCommand('project.create');

export function PrimarySidebar() {
    const allProjects = useProjects();
    /**
     * The tree is the only consumer that hides auto-registered worktree Projects. Filtering once here — before order,
     * collapse, activity order, and the Session windows read it — keeps every derived structure agreeing on which rows
     * exist; `allProjects` stays available for resolving a Session's Workbench Root below.
     */
    const loadedProjects = useMemo(
        () => (allProjects ? topLevelProjects(allProjects) : undefined),
        [allProjects],
    );
    const projects = loadedProjects ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const isFullScreen = useIsFullScreen();
    const autoCollapseSetting =
        useSettings()?.['primarySidebar.autoCollapseProjects'] ??
        defaultAppSettings['primarySidebar.autoCollapseProjects'];
    const archivedCount = sessions.filter((session) => session.archivedAt !== undefined).length;
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
     * The last tree row the user actually focused; feeds `rovingPrimarySidebarRowId`'s roving-tabindex resolution.
     */
    const [focusedRowId, setFocusedRowId] = useState<string>();
    const treeReference = useRef<HTMLDivElement>(null);
    const sessionRename = useSessionRename(sessions);
    // Owns the cadence only; each Session row subscribes to its own slice of the snapshot this keeps fresh.
    useSessionPullRequestPoll();
    const orderedSessions = useMemo(
        () => activeSessionsInSidebarOrder(projects, sessions),
        [projects, sessions],
    );
    const sessionOrder = useSessionOrder(orderedSessions);
    const sidebarSessions = sessionOrder.sessions;
    /**
     * Workbench Root Projects keyed by Session id, for the Sessions currently working outside their own Project. This
     * is what replaces the hidden top-level worktree entry, so it must resolve against the full Project list.
     */
    const worktreeProjects = useMemo(() => {
        const resolved: Record<string, ProjectRecord> = {};
        for (const session of sidebarSessions) {
            const worktree = sessionWorktreeProject(session, allProjects ?? NO_RECORDS);
            if (worktree) resolved[session.id] = worktree;
        }
        return resolved;
    }, [allProjects, sidebarSessions]);

    const isProjectExpanded = projectCollapse.isProjectExpanded;

    /**
     * One windowed Session list per Project, in sidebar order. Shared by the flattened tree rows and the rendered
     * groups so arrow-key navigation can never reach a Session the window hides.
     */
    const sessionWindows = useProjectSessionWindows({
        projects,
        selectedSessionId,
        sidebarSessions,
    });
    const projectWindows = sessionWindows.windows;

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

    const focusRow = useCallback((rowId: string): void => {
        treeReference.current
            ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
            ?.focus();
    }, []);

    const noteFocusedRow = useCreateSessionRowFocus({ focusRow, rovingRowId, rows: treeRows });

    const handleTreeFocus = useCallback(
        (event: FocusEvent<HTMLDivElement>): void => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const rowId = target.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
            if (!rowId) return;
            setFocusedRowId(rowId);
            noteFocusedRow(rowId);
        },
        [noteFocusedRow],
    );

    const toggleProject = (projectId: string): void => {
        setAnimatedProjectIds((current) => new Set(current).add(projectId));
        projectCollapse.toggleProject(projectId);
    };

    const revealMoreSessions = (sessionWindow: ProjectSessionWindow): void => {
        sessionWindows.revealMore(sessionWindow.project.id, sessionWindow.windowCount);
        // The final step unmounts the reveal row itself, which would drop the tree's roving Tab stop onto the document
        // body. Hand focus to the Session row directly above it while that row still exists — the same pre-unmount
        // handoff the Delete/Backspace archive path performs.
        const lastVisibleSessionId = sessionWindow.visibleSessions.at(-1)?.id;
        if (lastVisibleSessionId && sessionWindow.hiddenCount <= SESSION_REVEAL_STEP)
            focusRow(lastVisibleSessionId);
    };

    return (
        <aside className="session-primary-sidebar flex min-w-0 flex-col bg-surface">
            <PrimarySidebarHeader isFullScreen={isFullScreen} />
            <div
                className="project-list min-h-0 flex-1 overflow-auto p-2"
                onDragOver={(event) => {
                    if (
                        !(event.target instanceof Element) ||
                        !event.target.closest('.session-card')
                    )
                        sessionOrder.leaveList();
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    projectOrder.onListDragOver(event);
                }}
                onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                        projectCollapse.setHasFocus(false);
                }}
                onFocus={() => projectCollapse.setHasFocus(true)}
                onPointerEnter={() => projectCollapse.setIsHovered(true)}
                onPointerLeave={() => projectCollapse.setIsHovered(false)}
            >
                {/*
                 * The tree element holds Project and Session rows and nothing else. The empty-state action and the two
                 * live regions below sit outside it on purpose: inside a `role="tree"`, every focusable element has to
                 * be a real `treeitem` holding the tree's single roving Tab stop (DESIGN.md), and a static region is
                 * not a tree row at all. The scroll container, the Project drop target, and the hover/focus tracking
                 * stay on the wrapper so none of that changes with it.
                 */}
                <div
                    ref={treeReference}
                    aria-label="Primary Side Bar"
                    role="tree"
                    /*
                     * Not a Tab stop — rows own the only one — but `focusChromeSurface` falls back to the tree itself
                     * while it holds no rows, and `.focus()` on an element without a `tabIndex` does nothing at all. A
                     * Project-less workbench would otherwise answer `Cmd+0` by revealing the side bar and leaving the
                     * keyboard in the Terminal, with the empty state's Add Project button still out of reach.
                     */
                    tabIndex={-1}
                    onFocusCapture={handleTreeFocus}
                    onKeyDown={(event) =>
                        handlePrimarySidebarTreeKey(event, {
                            focusRow,
                            isProjectExpanded,
                            rows: treeRows,
                            toggleProject,
                        })
                    }
                >
                    {projectWindows.map((sessionWindow) => {
                        const {
                            hiddenCount,
                            nextRevealCount,
                            project,
                            projectSessions,
                            visibleSessions,
                        } = sessionWindow;
                        return (
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
                                onDragEnd={projectOrder.endDrag}
                                onDragOver={(event) =>
                                    projectOrder.updateDropTarget(event, project.id)
                                }
                                onDragStart={(event) => projectOrder.startDrag(event, project.id)}
                                onDrop={(event) => projectOrder.drop(event, project.id)}
                                onMove={(delta) =>
                                    projectOrder.move(project.id, project.displayTitle, delta)
                                }
                                onRenameValueChange={sessionRename.onRenameValueChange}
                                onRevealMoreSessions={() => revealMoreSessions(sessionWindow)}
                                onToggle={() => toggleProject(project.id)}
                                project={project}
                                projectSessions={projectSessions}
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
                                sessionOrder={sessionOrder}
                                terminals={terminals}
                                visibleSessions={visibleSessions}
                                worktreeProjects={worktreeProjects}
                            />
                        );
                    })}
                </div>
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
                <div className="session-order-announcement sr-only" aria-live="polite">
                    {sessionOrder.announcement}
                </div>
            </div>
            <PrimarySidebarFooter archivedCount={archivedCount} />
        </aside>
    );
}

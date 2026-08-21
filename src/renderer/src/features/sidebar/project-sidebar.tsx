import type { CSSProperties, FocusEvent, KeyboardEvent } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { Plus } from 'lucide-react';

import caxriLogoUrl from '../../assets/caxri-logo.png';
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
import { archiveSession, beginSessionCreation, selectProject } from '../session/session-actions';
import { useProjectCollapse } from './hooks/use-project-collapse';
import { ProjectGroup } from './project-group';
import { hasProjectDragType } from './project-order';
import { SessionHistoryNavigation } from './session-history-navigation';
import type { SidebarVerticalKey } from './sidebar-tree';
import {
    flattenSidebarRows,
    nextSidebarRowId,
    rovingSidebarRowId,
    sidebarArchiveIntent,
    sidebarHorizontalIntent,
} from './sidebar-tree';

const SIDEBAR_VERTICAL_KEYS: readonly SidebarVerticalKey[] = [
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
];

function isSidebarVerticalKey(key: string): key is SidebarVerticalKey {
    return (SIDEBAR_VERTICAL_KEYS as readonly string[]).includes(key);
}
import { useProjectOrder } from './hooks/use-project-order';
import { useSessionRename } from './hooks/use-session-rename';

const NO_RECORDS: never[] = [];
/**
 * Vite serves this repo-only asset in development without bundling it into production.
 */
const sidebarLogoUrl = import.meta.env.DEV ? '/src/assets/caxri-logo-dev.png' : caxriLogoUrl;
const onAddProject = (): void => executeCommand('project.create');

export function ProjectSidebar() {
    const loadedProjects = useProjects();
    const projects = loadedProjects ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const isFullScreen = useIsFullScreen();
    const autoCollapseSetting = useSettings()?.['sidebar.autoCollapseProjects'] ?? 'off';
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
     * The last tree row the user actually focused; feeds `rovingSidebarRowId`'s roving-tabindex resolution.
     */
    const [focusedRowId, setFocusedRowId] = useState<string>();
    const treeReference = useRef<HTMLDivElement>(null);
    const sessionRename = useSessionRename(sessions);

    const isProjectExpanded = projectCollapse.isProjectExpanded;

    /**
     * Flattened row order that Up/Down/Home/End walk; recomputed only when the tree's shape changes.
     */
    const treeRows = useMemo(() => {
        const projectNodes = projects.map((project) => {
            // Single pass instead of `.filter().map()`: react-doctor's combine-iterations rule
            // flags the chained form even though both walk the same small `sessions` array.
            const sessionIds: string[] = [];
            for (const session of sessions) {
                if (session.projectId === project.id && session.archivedAt === undefined)
                    sessionIds.push(session.id);
            }
            return { id: project.id, sessionIds };
        });
        return flattenSidebarRows(projectNodes, isProjectExpanded);
    }, [projects, sessions, isProjectExpanded]);

    /**
     * The single row that owns the tree's roving Tab stop (standard ARIA tree authoring pattern). Falls back through
     * the selected Session, then the selected Project, then the first row whenever `focusedRowId` is unset or has gone
     * stale (archived Session, collapsed Project).
     */
    const rovingRowId = useMemo(
        () => rovingSidebarRowId(treeRows, focusedRowId, selectedSessionId, selectedProjectId),
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
     * The Sidebar tree is a single roving Tab stop (standard ARIA tree authoring pattern): only the row in
     * `rovingRowId` is a Tab stop, and every inner control (disclosure, "New Session", archived-count, per-row Archive)
     * is `tabIndex={-1}`. This handler supplies the keyboard equivalents that stop being reachable by Tab:
     *
     * - Up/Down/Home/End walk every Project heading and its active Sessions.
     * - Left/Right expand/collapse a Project, or move a Session row to its owning Project.
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
        if (isSidebarVerticalKey(event.key)) {
            const nextRowId = nextSidebarRowId(treeRows, rowId, event.key);
            if (!nextRowId) return;
            event.preventDefault();
            focusRow(nextRowId);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const row = treeRows.find((item) => item.id === rowId);
            if (!row) return;
            const intent = sidebarHorizontalIntent(
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
            if (sidebarArchiveIntent(row, event.key) === 'archive') {
                event.preventDefault();
                // Compute where focus lands before the row leaves the DOM: the Project heading is
                // always above a Session row, so the ArrowUp fallback never comes up empty here.
                const focusAfterArchive =
                    nextSidebarRowId(treeRows, rowId, 'ArrowDown') ??
                    nextSidebarRowId(treeRows, rowId, 'ArrowUp');
                archiveSession(row.id);
                if (focusAfterArchive) focusRow(focusAfterArchive);
            }
        }
    };

    return (
        <aside className="session-sidebar flex min-w-0 flex-col bg-surface">
            <div
                className={`sidebar-title flex h-11 items-center py-0 pr-2 font-semibold ${isFullScreen ? 'pl-3' : 'pl-[84px]'}`}
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
                {isFullScreen && (
                    /**
                     * MacOS hides the traffic lights in fullscreen, leaving the reserved `pl-[84px]` gap empty. Show
                     * the logo instead so the sidebar header keeps a left-side anchor; `data-caxri-logo` also lets e2e
                     * assert it only exists here.
                     */
                    <img
                        src={sidebarLogoUrl}
                        alt="Caxri"
                        className="mr-2 h-7 w-7 object-contain"
                        data-caxri-logo
                    />
                )}
                <SessionHistoryNavigation />
            </div>
            <div
                ref={treeReference}
                aria-label="Sidebar"
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
                {projects.map((project) => {
                    const projectSessions = sessions.filter(
                        (session) => session.projectId === project.id,
                    );
                    const activeSessions = projectSessions.filter(
                        (session) => session.archivedAt === undefined,
                    );
                    return (
                        <ProjectGroup
                            key={project.id}
                            active={project.id === selectedProjectId}
                            activeSessions={activeSessions}
                            animateProject={animatedProjectIds.has(project.id)}
                            dragged={projectOrder.draggedProjectId === project.id}
                            expanded={isProjectExpanded(project.id)}
                            focusRenameInput={sessionRename.focusRenameInput}
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
                            onSelect={() => selectProject(project.id)}
                            onToggle={() => toggleProject(project.id)}
                            project={project}
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
                        />
                    );
                })}
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

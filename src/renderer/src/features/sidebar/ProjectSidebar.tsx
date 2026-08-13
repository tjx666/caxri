import { Archive, Plus } from 'lucide-react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import caxriLogoUrl from '../../assets/caxri-logo.png';
import { Button } from '../../components/ui/button';
import { CommandTooltip } from '../../components/ui/tooltip';
import { executeCommand } from '../../commands/execute';
import {
    useIsFullScreen,
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useTerminals,
} from '../../stores/selectors';
import { beginSessionCreation, renameSession, selectProject } from '../session/session-actions';
import { setArchivedSessionsOpen } from '../../stores/dialogs';
import { hasProjectDragType } from './project-order';
import { ProjectGroup } from './ProjectGroup';
import { flattenSidebarRows, nextSidebarRowId, sidebarHorizontalIntent } from './sidebar-tree';
import { useProjectOrder } from './useProjectOrder';

const NO_RECORDS: never[] = [];
/** Vite serves this repo-only asset in development without bundling it into production. */
const sidebarLogoUrl = import.meta.env.DEV ? '/src/assets/caxri-logo-dev.png' : caxriLogoUrl;
const onAddProject = (): void => executeCommand('project.create');

export function ProjectSidebar() {
    const projects = useProjects() ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const isFullScreen = useIsFullScreen();
    const selectedProjectId = useSelectedProject()?.id;
    const selectedSessionId = useSelectedSession()?.id;
    const projectOrder = useProjectOrder(projects);
    const archivedCount = sessions.filter((session) => session.archivedAt !== undefined).length;
    const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
    const [animatedProjectIds, setAnimatedProjectIds] = useState<Set<string>>(() => new Set());
    const [renamingSessionId, setRenamingSessionId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const renamingSessionIdRef = useRef<string | undefined>(undefined);
    const restoreFocusSessionIdRef = useRef<string | undefined>(undefined);
    const treeRef = useRef<HTMLDivElement>(null);

    /** Per-Project archived counts for the heading affix (item 5); the footer keeps the global total. */
    const archivedCountByProject = useMemo(() => {
        const counts = new Map<string, number>();
        for (const session of sessions) {
            if (session.archivedAt === undefined) continue;
            counts.set(session.projectId, (counts.get(session.projectId) ?? 0) + 1);
        }
        return counts;
    }, [sessions]);

    const isProjectExpanded = useCallback(
        (projectId: string) => !collapsedProjects.has(projectId),
        [collapsedProjects],
    );

    /** Flattened row order that Up/Down/Home/End walk; recomputed only when the tree's shape changes. */
    const treeRows = useMemo(() => {
        const projectNodes = projects.map((project) => ({
            id: project.id,
            sessionIds: sessions
                .filter(
                    (session) =>
                        session.projectId === project.id && session.archivedAt === undefined,
                )
                .map((session) => session.id),
        }));
        return flattenSidebarRows(projectNodes, isProjectExpanded);
    }, [projects, sessions, isProjectExpanded]);

    const focusRenameInput = useCallback((element: HTMLInputElement | null) => {
        element?.focus();
        element?.select();
    }, []);

    useEffect(() => {
        if (renamingSessionId) return;
        const sessionId = restoreFocusSessionIdRef.current;
        if (!sessionId) return;
        document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`)?.focus();
        restoreFocusSessionIdRef.current = undefined;
    }, [renamingSessionId, sessions]);

    const beginRename = (sessionId: string, displayTitle: string): void => {
        renamingSessionIdRef.current = sessionId;
        setRenamingSessionId(sessionId);
        setRenameValue(displayTitle);
        setRenameError(undefined);
    };

    /**
     * Clearing the active id synchronously makes key-repeat submissions no-ops. Blur deliberately
     * skips focus restoration so the control the user clicked keeps focus.
     */
    const finishRename = (sessionId: string, restoreFocus: boolean): void => {
        if (renamingSessionIdRef.current !== sessionId) return;
        renamingSessionIdRef.current = undefined;
        if (restoreFocus) restoreFocusSessionIdRef.current = sessionId;
        setRenamingSessionId((current) => (current === sessionId ? undefined : current));
        setRenameError(undefined);
    };

    const cancelRename = (): void => {
        const sessionId = renamingSessionIdRef.current;
        if (sessionId) finishRename(sessionId, true);
    };

    const commitRename = (): void => {
        const sessionId = renamingSessionIdRef.current;
        if (!sessionId) return;
        const displayTitle = renameValue.trim();
        if (!displayTitle) {
            setRenameError('Session name is required');
            return;
        }
        const currentTitle = sessions.find((session) => session.id === sessionId)?.displayTitle;
        finishRename(sessionId, true);
        if (displayTitle !== currentTitle) void renameSession(sessionId, displayTitle);
    };

    const blurRename = (): void => {
        const sessionId = renamingSessionIdRef.current;
        if (!sessionId) return;
        const displayTitle = renameValue.trim();
        const currentTitle = sessions.find((session) => session.id === sessionId)?.displayTitle;
        finishRename(sessionId, false);
        if (displayTitle && displayTitle !== currentTitle)
            void renameSession(sessionId, displayTitle);
    };

    const toggleProject = (projectId: string): void => {
        setAnimatedProjectIds((current) => new Set(current).add(projectId));
        setCollapsedProjects((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
    };

    const focusRow = (rowId: string): void => {
        treeRef.current
            ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
            ?.focus();
    };

    /**
     * Additive Up/Down/Left/Right/Home/End navigation across every Project heading and its active
     * Sessions (item 3 of the Sidebar keyboard-navigation audit). This intentionally layers on top
     * of — rather than replaces — the existing per-row Tab stops: several E2E specs already assert
     * a specific Tab order between the Project heading, "New Session", and the first Session card
     * (see `e2e/session-attention.e2e.ts` and `e2e/sidebar-chrome.e2e.ts`), so collapsing the whole
     * tree to a single roving Tab stop would need those specs updated in lockstep, which is outside
     * this work package's file set. Arrow keys resolve the actual reported pain point (reaching a
     * deep Session took dozens of Tab presses) without touching Tab order at all.
     */
    const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.closest('input, textarea')) return;
        const rowElement = target.closest<HTMLElement>('[data-row-id]');
        const rowId = rowElement?.dataset.rowId;
        if (!rowId) return;
        if (
            event.key === 'ArrowDown' ||
            event.key === 'ArrowUp' ||
            event.key === 'Home' ||
            event.key === 'End'
        ) {
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
        }
    };

    return (
        <aside className="session-sidebar group/sidebar flex min-w-0 flex-col bg-surface">
            <div
                className={`sidebar-title group/sidebar-title flex h-11 items-center justify-end border-b border-border py-0 pr-2 font-semibold ${isFullScreen ? 'pl-3' : 'pl-[84px]'}`}
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
                {isFullScreen && (
                    /**
                     * macOS hides the traffic lights in fullscreen, leaving the reserved
                     * `pl-[84px]` gap empty. Show the logo instead so the sidebar header keeps a
                     * left-side anchor; `data-caxri-logo` also lets e2e assert it only exists here.
                     */
                    <img
                        src={sidebarLogoUrl}
                        alt="Caxri"
                        className="mr-auto h-7 w-7 object-contain"
                        data-caxri-logo
                    />
                )}
                <CommandTooltip commandId="project.create">
                    <Button
                        className="pointer-events-none opacity-0 transition-opacity group-hover/sidebar:pointer-events-auto group-hover/sidebar:opacity-100 group-focus-within/sidebar-title:pointer-events-auto group-focus-within/sidebar-title:opacity-100"
                        size="icon"
                        variant="ghost"
                        aria-label="Add Project"
                        onClick={onAddProject}
                        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                    >
                        <Plus size={15} />
                    </Button>
                </CommandTooltip>
            </div>
            <div
                ref={treeRef}
                aria-label="Sidebar"
                className="project-list min-h-0 flex-1 overflow-auto p-2"
                role="tree"
                onDragOver={(event) => {
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    projectOrder.onListDragOver(event);
                }}
                onKeyDown={handleTreeKeyDown}
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
                            archivedCount={archivedCountByProject.get(project.id) ?? 0}
                            animateProject={animatedProjectIds.has(project.id)}
                            dragged={projectOrder.draggedProjectId === project.id}
                            expanded={isProjectExpanded(project.id)}
                            focusRenameInput={focusRenameInput}
                            onBeginRename={beginRename}
                            onBlurRename={blurRename}
                            onCancelRename={cancelRename}
                            onCommitRename={commitRename}
                            onCreateSession={() => beginSessionCreation(project.id)}
                            onDragEnd={projectOrder.endDrag}
                            onDragOver={(event) => projectOrder.updateDropTarget(event, project.id)}
                            onDragStart={(event) => projectOrder.startDrag(event, project.id)}
                            onDrop={(event) => projectOrder.drop(event, project.id)}
                            onMove={(delta) =>
                                projectOrder.move(project.id, project.displayTitle, delta)
                            }
                            onRenameValueChange={(value) => {
                                setRenameValue(value);
                                setRenameError(undefined);
                            }}
                            onSelect={() => selectProject(project.id)}
                            onToggle={() => toggleProject(project.id)}
                            project={project}
                            projectDropTarget={
                                projectOrder.projectDropTarget?.projectId === project.id
                                    ? projectOrder.projectDropTarget
                                    : undefined
                            }
                            renameError={renameError}
                            renameValue={renameValue}
                            renamingSessionId={renamingSessionId}
                            selectedSessionId={selectedSessionId}
                            terminals={terminals}
                        />
                    );
                })}
                {projects.length === 0 && (
                    <button
                        className="first-session flex w-full min-h-[72px] items-center justify-center gap-2 p-4 border border-dashed border-border rounded-md text-muted bg-transparent cursor-pointer hover:text-foreground hover:border-muted"
                        onClick={onAddProject}
                    >
                        <Plus size={16} /> Add your first Project
                    </button>
                )}
                <div className="project-order-announcement sr-only" aria-live="polite">
                    {projectOrder.projectOrderAnnouncement}
                </div>
            </div>
            <div className="border-t border-border p-2">
                <Button
                    className="archived-sessions-entry w-full justify-start text-muted hover:text-foreground"
                    size="sm"
                    variant="ghost"
                    onClick={() => setArchivedSessionsOpen(true)}
                >
                    <Archive aria-hidden="true" size={14} />
                    <span className="min-w-0 flex-1 truncate text-left">Archived Sessions</span>
                    <span
                        className="min-w-5 rounded-full bg-elevated px-1.5 text-center text-[10px] tabular-nums text-foreground"
                        data-archived-count={archivedCount}
                    >
                        {archivedCount}
                    </span>
                </Button>
            </div>
        </aside>
    );
}

import { Plus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

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
import { hasProjectDragType } from './project-order';
import { ProjectGroup } from './ProjectGroup';
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
    const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
    const [expandedArchives, setExpandedArchives] = useState<Set<string>>(() => new Set());
    const [animatedProjectIds, setAnimatedProjectIds] = useState<Set<string>>(() => new Set());
    const [animatedArchiveIds, setAnimatedArchiveIds] = useState<Set<string>>(() => new Set());
    const [renamingSessionId, setRenamingSessionId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const renamingSessionIdRef = useRef<string | undefined>(undefined);
    const restoreFocusSessionIdRef = useRef<string | undefined>(undefined);

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

    const toggleArchive = (projectId: string): void => {
        setAnimatedArchiveIds((current) => new Set(current).add(projectId));
        setExpandedArchives((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
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
                className="project-list min-h-0 flex-1 overflow-auto p-2"
                onDragOver={(event) => {
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    projectOrder.onListDragOver(event);
                }}
            >
                {projects.map((project) => {
                    const projectSessions = sessions.filter(
                        (session) => session.projectId === project.id,
                    );
                    const activeSessions = projectSessions.filter(
                        (session) => session.archivedAt === undefined,
                    );
                    const archivedSessions = projectSessions.filter(
                        (session) => session.archivedAt !== undefined,
                    );
                    return (
                        <ProjectGroup
                            key={project.id}
                            active={project.id === selectedProjectId}
                            activeSessions={activeSessions}
                            animateArchive={animatedArchiveIds.has(project.id)}
                            animateProject={animatedProjectIds.has(project.id)}
                            archiveExpanded={expandedArchives.has(project.id)}
                            archivedSessions={archivedSessions}
                            dragged={projectOrder.draggedProjectId === project.id}
                            expanded={!collapsedProjects.has(project.id)}
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
                            onToggleArchive={() => toggleArchive(project.id)}
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
        </aside>
    );
}

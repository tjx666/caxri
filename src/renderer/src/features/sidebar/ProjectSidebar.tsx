import {
    Archive,
    ArchiveRestore,
    ChevronDown,
    ChevronRight,
    Circle,
    FolderClosed,
    FolderOpen,
    Plus,
} from 'lucide-react';
import type { CSSProperties, DragEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentActivityState, SessionRecord, TerminalRecord } from '@shared/types';

import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { Button } from '../../components/ui/button';
import { CommandTooltip, Tooltip } from '../../components/ui/tooltip';
import { executeCommand } from '../../commands/execute';
import { cn } from '../../lib/utils';
import {
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useTerminals,
} from '../../stores/selectors';
import {
    archiveSession,
    beginSessionCreation,
    renameSession,
    reorderProject,
    selectProject,
    selectSession,
    unarchiveSession,
} from '../session/session-actions';
import {
    adjacentProjectOrder,
    createLatestProjectOrderQueue,
    PROJECT_DRAG_TYPE,
    projectDropTargetsEqual,
    projectOrderAfterDrop,
    type ProjectDropTarget,
} from './project-order';
import { DisclosureMotion } from './DisclosureMotion';

const NO_RECORDS: never[] = [];
/** Every activity color needs a text twin, so the dot carries the same wording as a tooltip. */
const ACTIVITY_LABELS: Record<AgentActivityState, string> = {
    completed: 'Finished',
    failed: 'Failed',
    idle: 'Idle',
    running: 'Working',
    unknown: 'No activity reported',
    waiting: 'Waiting for you',
};
const onAddProject = (): void => executeCommand('project.create');
const onSelectSession = (sessionId: string): void => void selectSession(sessionId);

const sessionCardClassName =
    'session-card flex w-full h-7 items-center gap-2 px-2 border-0 rounded-md bg-transparent text-foreground text-left cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]';

interface ActiveSessionRowProps {
    focusRenameInput: (element: HTMLInputElement | null) => void;
    onBeginRename: () => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onRenameValueChange: (value: string) => void;
    renameError?: string;
    renameValue: string;
    renaming: boolean;
    selected: boolean;
    session: SessionRecord;
    terminal?: TerminalRecord;
}

function ActiveSessionRow({
    focusRenameInput,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onRenameValueChange,
    renameError,
    renameValue,
    renaming,
    selected,
    session,
    terminal,
}: ActiveSessionRowProps) {
    const activityLabel = ACTIVITY_LABELS[session.lastActivityState];
    const renameErrorId = `session-rename-error-${session.id}`;
    return (
        <div className="session-row group/session-row relative">
            <div
                data-session-id={session.id}
                className={cn(
                    sessionCardClassName,
                    'pr-8',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground',
                    selected && 'active bg-elevated',
                    renaming && 'cursor-text',
                )}
                role={renaming ? undefined : 'button'}
                tabIndex={renaming ? undefined : 0}
                onClick={() => {
                    if (!renaming && !selected) onSelectSession(session.id);
                }}
                onDoubleClick={onBeginRename}
                onKeyDown={(event) => {
                    if (!renaming && event.key === 'Enter') {
                        event.preventDefault();
                        onBeginRename();
                    } else if (!renaming && event.key === ' ') {
                        event.preventDefault();
                        if (!selected) onSelectSession(session.id);
                    }
                }}
            >
                <span
                    role="img"
                    aria-label={activityLabel}
                    title={activityLabel}
                    className={cn(
                        `activity activity-${session.lastActivityState}`,
                        'flex flex-none items-center text-muted',
                        session.lastActivityState === 'running' && 'text-success',
                        session.lastActivityState === 'waiting' && 'text-warning',
                        session.lastActivityState === 'failed' && 'text-danger',
                    )}
                >
                    <Circle size={7} fill="currentColor" />
                </span>
                <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={14} />
                {renaming ? (
                    <>
                        <input
                            ref={focusRenameInput}
                            className="session-rename min-w-0 flex-1 rounded border border-border bg-background px-1 text-foreground outline-none focus:border-accent"
                            aria-label={`Rename ${session.displayTitle}`}
                            aria-invalid={Boolean(renameError)}
                            aria-describedby={renameError ? renameErrorId : undefined}
                            value={renameValue}
                            onBlur={onBlurRename}
                            onChange={(event) => onRenameValueChange(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    onCommitRename();
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    onCancelRename();
                                }
                            }}
                        />
                        {renameError && (
                            <span id={renameErrorId} role="alert" className="sr-only">
                                {renameError}
                            </span>
                        )}
                    </>
                ) : (
                    <span className="session-copy min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        <strong className="font-medium">{session.displayTitle}</strong>
                    </span>
                )}
            </div>
            <Tooltip content="Archive Session">
                <button
                    type="button"
                    className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded border-0 bg-elevated p-0 text-muted opacity-0 pointer-events-none cursor-pointer hover:text-foreground group-hover/session-row:opacity-100 group-hover/session-row:pointer-events-auto group-focus-within/session-row:opacity-100 group-focus-within/session-row:pointer-events-auto"
                    aria-label={`Archive ${session.displayTitle}`}
                    onClick={() => archiveSession(session.id)}
                >
                    <Archive size={12} />
                </button>
            </Tooltip>
        </div>
    );
}

interface ArchivedSessionsProps {
    animate: boolean;
    expanded: boolean;
    onToggle: () => void;
    sessions: SessionRecord[];
    terminals: TerminalRecord[];
}

function ArchivedSessions({
    animate,
    expanded,
    onToggle,
    sessions,
    terminals,
}: ArchivedSessionsProps) {
    return (
        <div className="archived-sessions mt-1">
            <button
                type="button"
                className="archived-sessions-toggle flex h-7 w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-[11px] text-muted cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                aria-expanded={expanded}
                onClick={onToggle}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Archive size={12} />
                <span className="flex-1">Archived</span>
                <span>{sessions.length}</span>
            </button>
            <DisclosureMotion animate={animate} expanded={expanded} kind="archive">
                {() =>
                    sessions.map((session) => {
                        const terminal = terminals.find(
                            (item) =>
                                item.sessionId === session.id &&
                                (item.id === session.primaryAgentTerminalId ||
                                    session.primaryAgentTerminalId === undefined),
                        );
                        return (
                            <Tooltip key={session.id} content="Restore Session">
                                <button
                                    type="button"
                                    className="archived-session flex h-7 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-muted cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                                    aria-label={`Restore ${session.displayTitle}`}
                                    onClick={() => unarchiveSession(session.id)}
                                >
                                    <ArchiveRestore size={12} />
                                    <AgentIdentityIcon
                                        identity={terminal?.kind ?? 'shell'}
                                        size={13}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                        {session.displayTitle}
                                    </span>
                                </button>
                            </Tooltip>
                        );
                    })
                }
            </DisclosureMotion>
        </div>
    );
}

export function ProjectSidebar() {
    const projects = useProjects() ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const selectedProjectId = useSelectedProject()?.id;
    const selectedSessionId = useSelectedSession()?.id;
    const onCreateSession = beginSessionCreation;
    const onSelectProject = selectProject;
    const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
    const [expandedArchives, setExpandedArchives] = useState<Set<string>>(() => new Set());
    const [animatedProjectIds, setAnimatedProjectIds] = useState<Set<string>>(() => new Set());
    const [animatedArchiveIds, setAnimatedArchiveIds] = useState<Set<string>>(() => new Set());
    const [renamingSessionId, setRenamingSessionId] = useState<string>();
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string>();
    const [draggedProjectId, setDraggedProjectId] = useState<string>();
    const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget>();
    const [projectOrderAnnouncement, setProjectOrderAnnouncement] = useState('');
    const renamingSessionIdRef = useRef<string | undefined>(undefined);
    const restoreFocusSessionIdRef = useRef<string | undefined>(undefined);
    const pendingProjectOrderRef = useRef<string[] | undefined>(undefined);
    const pendingProjectAnnouncementRef = useRef<
        { displayTitle: string; movedProjectId: string; projectIds: string[] } | undefined
    >(undefined);
    const projectOrderQueueRef = useRef<
        ReturnType<typeof createLatestProjectOrderQueue> | undefined
    >(undefined);

    useEffect(() => {
        projectOrderQueueRef.current = createLatestProjectOrderQueue(async (projectIds) => {
            const announcement = pendingProjectAnnouncementRef.current;
            if (announcement?.projectIds !== projectIds) return;
            const reordered = await reorderProject(
                announcement.movedProjectId,
                projectIds.indexOf(announcement.movedProjectId),
            );
            if (pendingProjectOrderRef.current !== projectIds) return;
            if (reordered) {
                setProjectOrderAnnouncement(
                    `Moved ${announcement.displayTitle} to position ${projectIds.indexOf(announcement.movedProjectId) + 1} of ${projectIds.length}`,
                );
            }
            pendingProjectOrderRef.current = undefined;
            pendingProjectAnnouncementRef.current = undefined;
        });
        return () => {
            projectOrderQueueRef.current = undefined;
        };
    }, []);

    /** Retains the latest keyboard intent while coalescing intermediate persistence writes. */
    const enqueueProjectOrder = (
        projectIds: string[],
        movedProjectId: string,
        displayTitle: string,
    ): void => {
        pendingProjectOrderRef.current = projectIds;
        pendingProjectAnnouncementRef.current = { displayTitle, movedProjectId, projectIds };
        void projectOrderQueueRef.current?.enqueue(projectIds);
    };

    const commitProjectOrder = (
        projectIds: string[],
        movedProjectId: string,
        displayTitle: string,
    ): void => {
        const currentIds = pendingProjectOrderRef.current ?? projects.map((project) => project.id);
        if (projectIds.every((projectId, index) => projectId === currentIds[index])) return;
        enqueueProjectOrder(projectIds, movedProjectId, displayTitle);
    };

    const moveProject = (projectId: string, displayTitle: string, delta: -1 | 1): void => {
        const projectIds = pendingProjectOrderRef.current ?? projects.map((project) => project.id);
        const reordered = adjacentProjectOrder(projectIds, projectId, delta);
        if (!reordered) return;
        enqueueProjectOrder(reordered, projectId, displayTitle);
    };

    const projectDropEdge = (
        event: DragEvent<HTMLElement>,
        projectId: string,
    ): ProjectDropTarget | undefined => {
        const draggedId = event.dataTransfer.getData(PROJECT_DRAG_TYPE) || draggedProjectId;
        if (!draggedId || draggedId === projectId) return undefined;
        const bounds = event.currentTarget.getBoundingClientRect();
        return {
            edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
            projectId,
        };
    };

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
                className="sidebar-title group/sidebar-title flex h-11 items-center justify-end border-b border-border py-0 pr-2 pl-[84px] font-semibold"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
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
                    if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) return;
                    const target = event.target;
                    if (!(target instanceof Element) || !target.closest('.project-heading'))
                        setProjectDropTarget(undefined);
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
                    const archiveExpanded = expandedArchives.has(project.id);
                    const expanded = !collapsedProjects.has(project.id);
                    const active = project.id === selectedProjectId;
                    const projectDisclosureId = `project-sessions-${project.id}`;
                    return (
                        <section
                            key={project.id}
                            data-project-id={project.id}
                            className={cn(
                                'project-group relative mb-2',
                                active && 'active',
                                draggedProjectId === project.id && 'opacity-40',
                            )}
                        >
                            {projectDropTarget?.projectId === project.id && (
                                <div
                                    className={cn(
                                        'project-drop-marker pointer-events-none absolute right-1 left-1 z-10 h-0.5 bg-accent',
                                        projectDropTarget.edge === 'before'
                                            ? '-top-1'
                                            : '-bottom-1',
                                    )}
                                    data-drop-edge={projectDropTarget.edge}
                                >
                                    <span className="absolute top-1/2 -left-0.5 size-1.5 -translate-y-1/2 rounded-full bg-accent" />
                                </div>
                            )}
                            <div
                                className={cn(
                                    'project-heading group/project-heading flex min-h-7 items-center gap-1 text-foreground cursor-grab active:cursor-grabbing',
                                )}
                                data-project-id={project.id}
                                draggable
                                onDragOver={(event) => {
                                    if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE))
                                        return;
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = 'move';
                                    const target = projectDropEdge(event, project.id);
                                    setProjectDropTarget((current) =>
                                        projectDropTargetsEqual(current, target) ? current : target,
                                    );
                                }}
                                onDrop={(event) => {
                                    if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE))
                                        return;
                                    event.preventDefault();
                                    const draggedId =
                                        event.dataTransfer.getData(PROJECT_DRAG_TYPE) ||
                                        draggedProjectId;
                                    const target = projectDropEdge(event, project.id);
                                    setDraggedProjectId(undefined);
                                    setProjectDropTarget(undefined);
                                    if (!draggedId || !target) return;
                                    const currentOrder =
                                        pendingProjectOrderRef.current ??
                                        projects.map((item) => item.id);
                                    const reordered = projectOrderAfterDrop(
                                        currentOrder,
                                        draggedId,
                                        target.projectId,
                                        target.edge,
                                    );
                                    const draggedProject = projects.find(
                                        (item) => item.id === draggedId,
                                    );
                                    if (draggedProject)
                                        commitProjectOrder(
                                            reordered,
                                            draggedProject.id,
                                            draggedProject.displayTitle,
                                        );
                                }}
                                onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = 'move';
                                    event.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id);
                                    event.dataTransfer.setData('text/plain', project.id);
                                    const preview =
                                        event.currentTarget.parentElement?.querySelector(
                                            '.project-drag-preview',
                                        );
                                    if (preview instanceof HTMLElement)
                                        event.dataTransfer.setDragImage(preview, 14, 14);
                                    setDraggedProjectId(project.id);
                                    setProjectDropTarget(undefined);
                                }}
                                onDragEnd={() => {
                                    setDraggedProjectId(undefined);
                                    setProjectDropTarget(undefined);
                                }}
                            >
                                <Tooltip
                                    content={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}
                                >
                                    <button
                                        className="project-disclosure grid h-7 w-6 flex-none place-items-center border-0 bg-transparent p-0 text-inherit cursor-pointer"
                                        aria-controls={projectDisclosureId}
                                        aria-expanded={expanded}
                                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}
                                        onClick={() => toggleProject(project.id)}
                                    >
                                        {expanded ? (
                                            <FolderOpen
                                                aria-hidden="true"
                                                className="project-folder-icon"
                                                size={15}
                                                strokeWidth={1.7}
                                            />
                                        ) : (
                                            <FolderClosed
                                                aria-hidden="true"
                                                className="project-folder-icon"
                                                size={15}
                                                strokeWidth={1.7}
                                            />
                                        )}
                                    </button>
                                </Tooltip>
                                <button
                                    className="project-select flex min-h-7 min-w-0 flex-1 items-center px-1 text-inherit text-left border-0 bg-transparent cursor-pointer"
                                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                                    onClick={() => {
                                        if (!active) onSelectProject(project.id);
                                        toggleProject(project.id);
                                    }}
                                    onKeyDown={(event) => {
                                        if (!event.altKey) return;
                                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                            event.preventDefault();
                                            moveProject(
                                                project.id,
                                                project.displayTitle,
                                                event.key === 'ArrowUp' ? -1 : 1,
                                            );
                                        }
                                    }}
                                    title={project.rootPath}
                                >
                                    <strong className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                                        {project.displayTitle}
                                    </strong>
                                </button>
                                <CommandTooltip commandId="session.create">
                                    <Button
                                        className="pointer-events-none opacity-0 transition-opacity group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100 group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100"
                                        size="icon"
                                        variant="ghost"
                                        aria-label={`New Session in ${project.displayTitle}`}
                                        onClick={() => onCreateSession(project.id)}
                                    >
                                        <Plus size={13} />
                                    </Button>
                                </CommandTooltip>
                            </div>
                            <div
                                aria-hidden="true"
                                className="project-drag-preview pointer-events-none fixed -top-[1000px] left-0 flex h-7 items-center gap-2 rounded-md bg-elevated px-2 text-foreground shadow-[0_8px_24px_var(--shadow)]"
                            >
                                <FolderClosed aria-hidden="true" size={15} strokeWidth={1.7} />
                                <span className="max-w-48 truncate text-[12px] font-medium">
                                    {project.displayTitle}
                                </span>
                            </div>
                            <DisclosureMotion
                                animate={animatedProjectIds.has(project.id)}
                                className="project-session-disclosure"
                                expanded={expanded}
                                hidden={draggedProjectId === project.id}
                                id={projectDisclosureId}
                                kind="project"
                            >
                                {() => (
                                    <div className="session-list pb-1 pl-4">
                                        {activeSessions.map((session) => {
                                            const sessionTerminals = terminals.filter(
                                                (item) => item.sessionId === session.id,
                                            );
                                            const terminal =
                                                sessionTerminals.find(
                                                    (item) =>
                                                        item.id === session.primaryAgentTerminalId,
                                                ) ?? sessionTerminals[0];
                                            return (
                                                <ActiveSessionRow
                                                    key={session.id}
                                                    focusRenameInput={focusRenameInput}
                                                    onBeginRename={() =>
                                                        beginRename(
                                                            session.id,
                                                            session.displayTitle,
                                                        )
                                                    }
                                                    onBlurRename={blurRename}
                                                    onCancelRename={cancelRename}
                                                    onCommitRename={commitRename}
                                                    onRenameValueChange={(value) => {
                                                        setRenameValue(value);
                                                        setRenameError(undefined);
                                                    }}
                                                    renameError={renameError}
                                                    renameValue={renameValue}
                                                    renaming={session.id === renamingSessionId}
                                                    selected={session.id === selectedSessionId}
                                                    session={session}
                                                    terminal={terminal}
                                                />
                                            );
                                        })}
                                        {activeSessions.length === 0 && (
                                            <button
                                                className="empty-project flex h-7 w-full items-center gap-2 px-2 border-0 rounded-md text-muted bg-transparent cursor-pointer hover:text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]"
                                                onClick={() => onCreateSession(project.id)}
                                            >
                                                <Plus size={13} /> New Session
                                            </button>
                                        )}
                                        {archivedSessions.length > 0 && (
                                            <ArchivedSessions
                                                animate={animatedArchiveIds.has(project.id)}
                                                expanded={archiveExpanded}
                                                onToggle={() => toggleArchive(project.id)}
                                                sessions={archivedSessions}
                                                terminals={terminals}
                                            />
                                        )}
                                    </div>
                                )}
                            </DisclosureMotion>
                        </section>
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
                    {projectOrderAnnouncement}
                </div>
            </div>
        </aside>
    );
}

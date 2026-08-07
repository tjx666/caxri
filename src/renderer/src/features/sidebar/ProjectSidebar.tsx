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
import type { CSSProperties } from 'react';
import { useState } from 'react';

import type { AgentActivityState } from '@shared/types';

import caxriLogoUrl from '../../assets/caxri-logo.png';
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
    selectProject,
    selectSession,
    unarchiveSession,
} from '../session/session-actions';

const NO_RECORDS: never[] = [];
/** Vite serves this repo-only asset in development without bundling it into production. */
const sidebarLogoUrl = import.meta.env.DEV ? '/src/assets/caxri-logo-dev.png' : caxriLogoUrl;

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
    'session-card flex w-full h-7 items-center gap-2 px-2 border-0 rounded-md bg-transparent text-muted text-left cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground';

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

    const toggleProject = (projectId: string): void => {
        setCollapsedProjects((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
    };

    const toggleArchive = (projectId: string): void => {
        setExpandedArchives((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
    };

    return (
        <aside className="session-sidebar group flex min-w-0 flex-col bg-surface">
            <div
                className="sidebar-title flex min-h-11 items-center justify-between border-b border-border py-0 pr-2 pl-[84px] font-semibold"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
                <img
                    src={sidebarLogoUrl}
                    alt="Caxri"
                    className="h-7 w-7 object-contain"
                    data-caxri-logo
                />
                <CommandTooltip commandId="project.create">
                    <Button
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
            <div className="project-list min-h-0 flex-1 overflow-auto p-2">
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
                    return (
                        <section
                            key={project.id}
                            className={cn('project-group', 'mb-2', active && 'active')}
                        >
                            <div
                                className={cn(
                                    'project-heading group/project-heading flex min-h-7 items-center gap-1 text-muted',
                                    active && 'text-foreground',
                                )}
                            >
                                <Tooltip
                                    content={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}
                                >
                                    <button
                                        className="project-disclosure grid h-7 w-6 flex-none place-items-center border-0 bg-transparent p-0 text-inherit cursor-pointer"
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
                                    onClick={() => {
                                        if (!active) onSelectProject(project.id);
                                        toggleProject(project.id);
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
                            {expanded && (
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
                                        const activityLabel =
                                            ACTIVITY_LABELS[session.lastActivityState];
                                        const sessionActive = session.id === selectedSessionId;
                                        return (
                                            <div
                                                key={session.id}
                                                className="session-row group/session-row relative"
                                            >
                                                <button
                                                    data-session-id={session.id}
                                                    className={cn(
                                                        sessionCardClassName,
                                                        'pr-8',
                                                        sessionActive &&
                                                            'active bg-elevated text-foreground',
                                                    )}
                                                    onClick={() => onSelectSession(session.id)}
                                                >
                                                    <span
                                                        role="img"
                                                        aria-label={activityLabel}
                                                        title={activityLabel}
                                                        className={cn(
                                                            `activity activity-${session.lastActivityState}`,
                                                            'flex flex-none items-center text-muted',
                                                            session.lastActivityState ===
                                                                'running' && 'text-success',
                                                            session.lastActivityState ===
                                                                'waiting' && 'text-warning',
                                                            session.lastActivityState ===
                                                                'failed' && 'text-danger',
                                                        )}
                                                    >
                                                        <Circle size={7} fill="currentColor" />
                                                    </span>
                                                    <AgentIdentityIcon
                                                        identity={terminal?.kind ?? 'shell'}
                                                        size={14}
                                                    />
                                                    <span className="session-copy min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                                                        <strong className="font-medium">
                                                            {session.displayTitle}
                                                        </strong>
                                                    </span>
                                                </button>
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
                                        <div className="archived-sessions mt-1">
                                            <button
                                                type="button"
                                                className="archived-sessions-toggle flex h-7 w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-[11px] text-muted cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                                                aria-expanded={archiveExpanded}
                                                onClick={() => toggleArchive(project.id)}
                                            >
                                                {archiveExpanded ? (
                                                    <ChevronDown size={12} />
                                                ) : (
                                                    <ChevronRight size={12} />
                                                )}
                                                <Archive size={12} />
                                                <span className="flex-1">Archived</span>
                                                <span>{archivedSessions.length}</span>
                                            </button>
                                            {archiveExpanded &&
                                                archivedSessions.map((session) => {
                                                    const terminal = terminals.find(
                                                        (item) =>
                                                            item.sessionId === session.id &&
                                                            (item.id ===
                                                                session.primaryAgentTerminalId ||
                                                                session.primaryAgentTerminalId ===
                                                                    undefined),
                                                    );
                                                    return (
                                                        <Tooltip
                                                            key={session.id}
                                                            content="Restore Session"
                                                        >
                                                            <button
                                                                type="button"
                                                                className="archived-session flex h-7 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-muted cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                                                                aria-label={`Restore ${session.displayTitle}`}
                                                                onClick={() =>
                                                                    unarchiveSession(session.id)
                                                                }
                                                            >
                                                                <ArchiveRestore size={12} />
                                                                <AgentIdentityIcon
                                                                    identity={
                                                                        terminal?.kind ?? 'shell'
                                                                    }
                                                                    size={13}
                                                                />
                                                                <span className="min-w-0 flex-1 truncate">
                                                                    {session.displayTitle}
                                                                </span>
                                                            </button>
                                                        </Tooltip>
                                                    );
                                                })}
                                        </div>
                                    )}
                                </div>
                            )}
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
            </div>
        </aside>
    );
}

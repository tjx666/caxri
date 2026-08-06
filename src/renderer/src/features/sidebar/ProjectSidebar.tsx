import { ChevronDown, ChevronRight, Circle, Plus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useState } from 'react';

import type { AgentActivityState } from '@shared/types';

import { AgentIdentityIcon } from '../../agent-icons/AgentIdentityIcon';
import { Button } from '../../components/ui/button';
import { executeCommand } from '../../commands/execute';
import { cn } from '../../lib/utils';
import {
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useTerminals,
} from '../../state/selectors';
import { beginSessionCreation, selectProject, selectSession } from '../session/session-actions';

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

    const toggleProject = (projectId: string): void => {
        setCollapsedProjects((current) => {
            const next = new Set(current);
            if (next.has(projectId)) next.delete(projectId);
            else next.add(projectId);
            return next;
        });
    };

    return (
        <aside className="session-sidebar group flex min-w-0 flex-col bg-surface">
            <div
                className="sidebar-title flex min-h-11 items-center justify-end border-b border-border py-0 pr-2 pl-[84px] font-semibold"
                style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            >
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Add Project"
                    onClick={onAddProject}
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                >
                    <Plus size={15} />
                </Button>
            </div>
            <div className="project-list min-h-0 flex-1 overflow-auto p-2">
                {projects.map((project) => {
                    const projectSessions = sessions.filter(
                        (session) => session.projectId === project.id,
                    );
                    const expanded = !collapsedProjects.has(project.id);
                    const active = project.id === selectedProjectId;
                    return (
                        <section
                            key={project.id}
                            className={cn('project-group', 'mb-2', active && 'active')}
                        >
                            <div
                                className={cn(
                                    'project-heading flex min-h-7 items-center gap-1 text-muted',
                                    active && 'text-foreground',
                                )}
                            >
                                <button
                                    className="project-disclosure grid h-7 w-4 flex-none place-items-center border-0 bg-transparent p-0 text-inherit cursor-pointer"
                                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}
                                    onClick={() => toggleProject(project.id)}
                                >
                                    {expanded ? (
                                        <ChevronDown size={13} />
                                    ) : (
                                        <ChevronRight size={13} />
                                    )}
                                </button>
                                <button
                                    className="project-select flex min-h-7 min-w-0 flex-1 items-center px-1 text-inherit text-left border-0 bg-transparent cursor-pointer"
                                    onClick={() => onSelectProject(project.id)}
                                    title={project.rootPath}
                                >
                                    <span className="project-copy flex min-w-0 flex-1 items-baseline gap-2">
                                        <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                                            {project.displayTitle}
                                        </strong>
                                        <small className="flex-none text-muted text-[11px]">
                                            {projectSessions.length}
                                        </small>
                                    </span>
                                </button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`New Session in ${project.displayTitle}`}
                                    onClick={() => onCreateSession(project.id)}
                                >
                                    <Plus size={13} />
                                </Button>
                            </div>
                            {expanded && (
                                <div className="session-list pb-1 pl-4">
                                    {projectSessions.map((session) => {
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
                                            <button
                                                key={session.id}
                                                data-session-id={session.id}
                                                className={cn(
                                                    sessionCardClassName,
                                                    sessionActive &&
                                                        'active bg-elevated text-foreground group-focus-within:shadow-[inset_2px_0_var(--accent)]',
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
                                                        session.lastActivityState === 'running' &&
                                                            'text-success',
                                                        session.lastActivityState === 'waiting' &&
                                                            'text-warning',
                                                        session.lastActivityState === 'failed' &&
                                                            'text-danger',
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
                                        );
                                    })}
                                    {projectSessions.length === 0 && (
                                        <button
                                            className="empty-project flex h-7 w-full items-center gap-2 px-2 border-0 rounded-md text-muted bg-transparent cursor-pointer hover:text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]"
                                            onClick={() => onCreateSession(project.id)}
                                        >
                                            <Plus size={13} /> New Session
                                        </button>
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

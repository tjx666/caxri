import {
    ChevronDown,
    ChevronRight,
    Circle,
    Folder,
    Plus,
    Search,
    Settings,
    TerminalSquare,
} from 'lucide-react';
import { useState } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@shared/types';

import { AgentIdentityIcon } from '../agent-icons/AgentIdentityIcon';
import { Button } from './ui/button';

interface ProjectSidebarProps {
    projects: ProjectRecord[];
    sessions: SessionRecord[];
    terminals: TerminalRecord[];
    selectedProjectId?: string;
    selectedSessionId?: string;
    onAddProject: () => void;
    onCreateSession: (projectId: string) => void;
    onSelectProject: (projectId: string) => void;
    onSelectSession: (sessionId: string) => void;
    onOpenSettings: () => void;
    onSearch: () => void;
}

export function ProjectSidebar({
    projects,
    sessions,
    terminals,
    selectedProjectId,
    selectedSessionId,
    onAddProject,
    onCreateSession,
    onSelectProject,
    onSelectSession,
    onOpenSettings,
    onSearch,
}: ProjectSidebarProps) {
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
        <aside className="session-sidebar">
            <div className="sidebar-title">
                <span>
                    <TerminalSquare size={16} /> Caxri
                </span>
                <Button size="icon" variant="ghost" aria-label="Add Project" onClick={onAddProject}>
                    <Plus size={15} />
                </Button>
            </div>
            <div className="project-list">
                {projects.map((project) => {
                    const projectSessions = sessions.filter(
                        (session) => session.projectId === project.id,
                    );
                    const expanded = !collapsedProjects.has(project.id);
                    return (
                        <section
                            key={project.id}
                            className={
                                project.id === selectedProjectId
                                    ? 'project-group active'
                                    : 'project-group'
                            }
                        >
                            <div className="project-heading">
                                <button
                                    className="project-disclosure"
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
                                    className="project-select"
                                    onClick={() => onSelectProject(project.id)}
                                    title={project.rootPath}
                                >
                                    <Folder size={14} />
                                    <span className="project-copy">
                                        <strong>{project.displayTitle}</strong>
                                        <small>{project.rootPath}</small>
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
                                <div className="session-list">
                                    {projectSessions.map((session) => {
                                        const sessionTerminals = terminals.filter(
                                            (item) => item.sessionId === session.id,
                                        );
                                        const terminal =
                                            sessionTerminals.find(
                                                (item) =>
                                                    item.id === session.primaryAgentTerminalId,
                                            ) ?? sessionTerminals[0];
                                        return (
                                            <button
                                                key={session.id}
                                                data-session-id={session.id}
                                                className={
                                                    session.id === selectedSessionId
                                                        ? 'session-card active'
                                                        : 'session-card'
                                                }
                                                onClick={() => onSelectSession(session.id)}
                                            >
                                                <span
                                                    className={`activity activity-${session.lastActivityState}`}
                                                >
                                                    <Circle size={7} fill="currentColor" />
                                                </span>
                                                <AgentIdentityIcon
                                                    identity={terminal?.kind ?? 'shell'}
                                                    size={14}
                                                />
                                                <span className="session-copy">
                                                    <strong>{session.displayTitle}</strong>
                                                    <em>{terminal?.title ?? 'Shell'}</em>
                                                </span>
                                            </button>
                                        );
                                    })}
                                    {projectSessions.length === 0 && (
                                        <button
                                            className="empty-project"
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
                    <button className="first-session" onClick={onAddProject}>
                        <Plus size={16} /> Add your first Project
                    </button>
                )}
            </div>
            <div className="sidebar-footer">
                <Button size="icon" variant="ghost" aria-label="Settings" onClick={onOpenSettings}>
                    <Settings size={15} />
                </Button>
                <Button size="icon" variant="ghost" aria-label="Search" onClick={onSearch}>
                    <Search size={15} />
                </Button>
            </div>
        </aside>
    );
}

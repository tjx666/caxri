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

import { AgentIdentityIcon } from '../../agent-icons/AgentIdentityIcon';
import { Button } from '../../components/ui/button';
import { executeCommand } from '../../commands/execute';
import {
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useTerminals,
} from '../../state/selectors';
import { beginSessionCreation, selectProject, selectSession } from '../session/session-actions';

const NO_RECORDS: never[] = [];
const onAddProject = (): void => executeCommand('project.create');
const onOpenSettings = (): void => executeCommand('theme.openSettings');
const onSearch = (): void => executeCommand('commandPalette.open');
const onSelectSession = (sessionId: string): void => void selectSession(sessionId);

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

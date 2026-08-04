import { Command } from 'cmdk';

import { commands } from '@/commands';
import type { ProjectRecord, SessionRecord } from '@shared/types';

import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

export function CommandPalette({
    open,
    onOpenChange,
    execute,
    projects,
    sessions,
    selectProject,
    selectSession,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    execute: (command: string) => void;
    projects: ProjectRecord[];
    sessions: SessionRecord[];
    selectProject: (projectId: string) => void;
    selectSession: (sessionId: string) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="command-dialog">
                <DialogTitle className="sr-only">Command Palette</DialogTitle>
                <Command label="Command Palette">
                    <Command.Input
                        autoFocus
                        placeholder="Search projects, sessions, and commands…"
                    />
                    <Command.List>
                        <Command.Empty>No Project, Session, or command found.</Command.Empty>
                        <Command.Group heading="Projects">
                            {projects.map((project) => (
                                <Command.Item
                                    key={project.id}
                                    value={`Project ${project.displayTitle} ${project.rootPath}`}
                                    onSelect={() => {
                                        onOpenChange(false);
                                        selectProject(project.id);
                                    }}
                                >
                                    <span>{project.displayTitle}</span>
                                    <small>Project</small>
                                </Command.Item>
                            ))}
                        </Command.Group>
                        <Command.Group heading="Sessions">
                            {sessions.map((session) => {
                                const project = projects.find(
                                    (item) => item.id === session.projectId,
                                );
                                return (
                                    <Command.Item
                                        key={session.id}
                                        value={`Session ${session.displayTitle} ${project?.displayTitle ?? ''} ${project?.rootPath ?? ''}`}
                                        onSelect={() => {
                                            onOpenChange(false);
                                            selectSession(session.id);
                                        }}
                                    >
                                        <span>{session.displayTitle}</span>
                                        <small>{project?.displayTitle ?? 'Session'}</small>
                                    </Command.Item>
                                );
                            })}
                        </Command.Group>
                        <Command.Group heading="Commands">
                            {commands.map((command) => (
                                <Command.Item
                                    key={command.id}
                                    value={`${command.category} ${command.title} ${command.id}`}
                                    onSelect={() => {
                                        onOpenChange(false);
                                        execute(command.id);
                                    }}
                                >
                                    <span>{command.title}</span>
                                    <small>{command.category}</small>
                                </Command.Item>
                            ))}
                        </Command.Group>
                    </Command.List>
                </Command>
            </DialogContent>
        </Dialog>
    );
}

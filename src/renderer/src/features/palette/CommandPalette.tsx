import { Command } from 'cmdk';

import { commandDefinitions } from '@shared/commands';

import { executeCommand } from '../../commands/execute';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { useCommandShortcut } from '../../lib/keybindings';
import { setPaletteOpen, useDialogStore } from '../../state/dialogs';
import { useProjects, useSessions } from '../../state/selectors';
import { selectProject, selectSession } from '../session/session-actions';

const NO_RECORDS: never[] = [];

function CommandRow({ command }: { command: (typeof commandDefinitions)[number] }) {
    const shortcut = useCommandShortcut(command.id);
    return (
        <Command.Item
            value={`${command.category} ${command.title} ${command.id}`}
            onSelect={() => {
                setPaletteOpen(false);
                executeCommand(command.id);
            }}
        >
            <span>{command.title}</span>
            <small>
                {command.category}
                {shortcut && <kbd className="command-shortcut">{shortcut}</kbd>}
            </small>
        </Command.Item>
    );
}

export function CommandPalette() {
    const open = useDialogStore((state) => state.paletteOpen);
    const onOpenChange = setPaletteOpen;
    const projects = useProjects() ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* The palette closes on Escape or on select; a close X would be dead weight in it. */}
            <DialogContent className="command-dialog" showCloseButton={false}>
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
                                            void selectSession(session.id);
                                        }}
                                    >
                                        <span>{session.displayTitle}</span>
                                        <small>{project?.displayTitle ?? 'Session'}</small>
                                    </Command.Item>
                                );
                            })}
                        </Command.Group>
                        <Command.Group heading="Commands">
                            {commandDefinitions.map((command) => (
                                <CommandRow key={command.id} command={command} />
                            ))}
                        </Command.Group>
                    </Command.List>
                </Command>
            </DialogContent>
        </Dialog>
    );
}

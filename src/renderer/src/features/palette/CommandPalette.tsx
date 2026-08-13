import { Command } from 'cmdk';

import { commandDefinitions } from '@shared/commands';

import { executeCommand } from '../../commands/execute';
import { ShortcutBadge } from '../../components/ShortcutBadge';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { useCommandShortcut } from '../../lib/keybindings';
import { setPaletteOpen, useDialogStore } from '../../stores/dialogs';
import { useProjects, useSessions } from '../../stores/selectors';
import { selectProject, selectSession } from '../session/session-actions';

const NO_RECORDS: never[] = [];

// Shared row shell for every `Command.Item`: `cmdk` toggles its own `data-selected`
// attribute, so the selected-row fill is expressed as a `data-[selected=true]` variant
// instead of the old `[cmdk-item][data-selected='true']` global-CSS attribute selector.
const commandItemClassName =
    'group flex min-h-7 cursor-pointer items-start justify-between gap-2 rounded px-2 py-1 data-[selected=true]:bg-elevated';
const commandItemMetaClassName = 'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * Every command already carries a plain-language `description` in the shared catalog (e.g.
 * Screencast Mode's explains it overlays clicks/keystrokes without hiding anything), but nothing
 * in the palette ever rendered it. Showing it as a secondary line benefits every command, not just
 * the ones whose title alone is ambiguous.
 */
function CommandRow({ command }: { command: (typeof commandDefinitions)[number] }) {
    const shortcut = useCommandShortcut(command.id);
    return (
        <Command.Item
            className={commandItemClassName}
            value={`${command.category} ${command.title} ${command.id}`}
            onSelect={() => {
                setPaletteOpen(false);
                executeCommand(command.id);
            }}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span>{command.title}</span>
                <span className="truncate text-[11px] text-muted">{command.description}</span>
            </span>
            <small className={commandItemMetaClassName}>
                {command.category}
                {shortcut && (
                    <ShortcutBadge
                        compact
                        keyClassName="group-data-[selected=true]:bg-[var(--selection)]"
                        shortcut={shortcut}
                    />
                )}
            </small>
        </Command.Item>
    );
}

export function CommandPalette() {
    const open = useDialogStore((state) => state.paletteOpen);
    const onOpenChange = setPaletteOpen;
    const projects = useProjects() ?? NO_RECORDS;
    const sessions = (useSessions() ?? NO_RECORDS).filter(
        (session) => session.archivedAt === undefined,
    );
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* The palette closes on Escape or on select; a close X would be dead weight in it. */}
            <DialogContent
                className="top-[18%] w-[min(560px,calc(100vw-32px))] translate-y-0 overflow-hidden"
                showCloseButton={false}
            >
                <DialogTitle className="sr-only">Command Palette</DialogTitle>
                <Command label="Command Palette" className="w-full">
                    <Command.Input
                        autoFocus
                        className="h-11 w-full border-0 border-b border-border bg-background px-4 text-[13px] text-foreground outline-none"
                        placeholder="Search projects, sessions, and commands…"
                    />
                    <Command.List className="max-h-[360px] overflow-auto p-1">
                        <Command.Empty className="p-6 text-center text-muted">
                            No Project, Session, or command found.
                        </Command.Empty>
                        <Command.Group heading="Projects">
                            {projects.map((project) => (
                                <Command.Item
                                    key={project.id}
                                    className={commandItemClassName}
                                    value={`Project ${project.displayTitle} ${project.rootPath}`}
                                    onSelect={() => {
                                        onOpenChange(false);
                                        selectProject(project.id);
                                    }}
                                >
                                    <span>{project.displayTitle}</span>
                                    <small className={commandItemMetaClassName}>Project</small>
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
                                        className={commandItemClassName}
                                        value={`Session ${session.displayTitle} ${project?.displayTitle ?? ''} ${project?.rootPath ?? ''}`}
                                        onSelect={() => {
                                            onOpenChange(false);
                                            void selectSession(session.id);
                                        }}
                                    >
                                        <span>{session.displayTitle}</span>
                                        <small className={commandItemMetaClassName}>
                                            {project?.displayTitle ?? 'Session'}
                                        </small>
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

import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { commandDefinitions } from '@shared/commands';

import { executeCommand } from '../../commands/execute';
import { ShortcutBadge } from '../../components/shortcut-badge';
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { useCommandShortcut } from '../../lib/keybindings';
import { useCaxriQuery } from '../../queries/client';
import { setPaletteOpen, useDialogStore } from '../../stores/dialogs';
import { useProjects, useSessions } from '../../stores/selectors';
import { didSelectSession, selectProject } from '../session/session-actions';
import { didExecuteViewCatalogCommand } from '../view-containers/view-container-commands';
import { getPaletteExtensionCommands } from './command-palette-commands';

const NO_RECORDS: never[] = [];

const commandItemMetaClassName = 'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * Every command already carries a plain-language `description` in the shared catalog (e.g. Screencast Mode's explains
 * it overlays clicks/keystrokes without hiding anything), but nothing in the palette ever rendered it. Showing it as a
 * secondary line benefits every command, not just the ones whose title alone is ambiguous.
 */
function CommandRow({ command }: { command: (typeof commandDefinitions)[number] }) {
    const shortcut = useCommandShortcut(command.id);
    return (
        <CommandItem
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
        </CommandItem>
    );
}

function DynamicCommandRow({
    catalog,
    command,
}: {
    catalog: ViewCatalogSnapshot;
    command: { id: string; title: string; description?: string };
}) {
    return (
        <CommandItem
            value={`Extension ${command.title} ${command.id}`}
            onSelect={() => {
                setPaletteOpen(false);
                didExecuteViewCatalogCommand(catalog, command.id);
            }}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span>{command.title}</span>
                {command.description && (
                    <span className="truncate text-[11px] text-muted">{command.description}</span>
                )}
            </span>
            <small className={commandItemMetaClassName}>Extension</small>
        </CommandItem>
    );
}

export function CommandPalette() {
    const isOpen = useDialogStore((state) => state.paletteOpen);
    const onOpenChange = setPaletteOpen;
    const projects = useProjects() ?? NO_RECORDS;
    const catalog = useCaxriQuery('viewContainers.catalog', {}, { enabled: isOpen }).data;
    const sessions = (useSessions() ?? NO_RECORDS).filter(
        (session) => session.archivedAt === undefined,
    );
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            {/* The palette closes on Escape or on select; a close X would be dead weight in it. */}
            <DialogContent
                className="top-[18%] w-[min(560px,calc(100vw-32px))] translate-y-0 overflow-hidden"
                showCloseButton={false}
            >
                <DialogTitle className="sr-only">Command Palette</DialogTitle>
                <Command label="Command Palette" className="w-full">
                    <CommandInput
                        autoFocus
                        placeholder="Search projects, sessions, and commands…"
                    />
                    <CommandList>
                        <CommandEmpty>No Project, Session, or command found.</CommandEmpty>
                        <CommandGroup heading="Projects">
                            {projects.map((project) => (
                                <CommandItem
                                    key={project.id}
                                    value={`Project ${project.displayTitle} ${project.rootPath}`}
                                    onSelect={() => {
                                        onOpenChange(false);
                                        selectProject(project.id);
                                    }}
                                >
                                    <span>{project.displayTitle}</span>
                                    <small className={commandItemMetaClassName}>Project</small>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandGroup heading="Sessions">
                            {sessions.map((session) => {
                                const project = projects.find(
                                    (item) => item.id === session.projectId,
                                );
                                return (
                                    <CommandItem
                                        key={session.id}
                                        value={`Session ${session.displayTitle} ${project?.displayTitle ?? ''} ${project?.rootPath ?? ''}`}
                                        onSelect={() => {
                                            onOpenChange(false);
                                            // eslint-disable-next-line no-void -- intentional floating-promise discard, didSelectSession() reports its own errors
                                            void didSelectSession(session.id);
                                        }}
                                    >
                                        <span>{session.displayTitle}</span>
                                        <small className={commandItemMetaClassName}>
                                            {project?.displayTitle ?? 'Session'}
                                        </small>
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                        <CommandGroup heading="Commands">
                            {commandDefinitions.map((command) =>
                                command.requiresArguments ? null : (
                                    <CommandRow key={command.id} command={command} />
                                ),
                            )}
                            {getPaletteExtensionCommands(catalog).map((command) => (
                                <DynamicCommandRow
                                    key={command.id}
                                    catalog={catalog!}
                                    command={command}
                                />
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </DialogContent>
        </Dialog>
    );
}

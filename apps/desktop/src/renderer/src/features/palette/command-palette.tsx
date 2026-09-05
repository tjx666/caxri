import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';

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
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { useCommandShortcut } from '../../lib/keybindings';
import { useCaxriQuery } from '../../queries/client';
import { setPaletteOpen, useDialogStore } from '../../stores/dialogs';
import { useProjects, useSelectedSession, useSessions, useTerminals } from '../../stores/selectors';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import {
    didSelectSession,
    hasDetachedAgentTerminal,
    hasLiveAgentTerminal,
    selectProject,
} from '../session/session-actions';
import { activeSessionsInSidebarOrder } from '../session/session-activity-order';
import { didExecuteViewCatalogCommand } from '../view-containers/view-container-commands';
import {
    getPaletteExtensionCommands,
    getStaticCommandPaletteValue,
    isCommandVisibleInPalette,
} from './command-palette-commands';

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
            value={getStaticCommandPaletteValue(command)}
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
            value={`Extension ${command.title} ${command.id} ${command.description ?? ''}`}
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
    /**
     * Only the Projects group filters. Selecting an auto-registered worktree Project does nothing — it can never own a
     * Session — so offering it is a dead result. Session ordering and the Session subtitles below stay on the full
     * list, or a Session working in a worktree would lose its Project name.
     */
    const projectResults = topLevelProjects(projects);
    const catalog = useCaxriQuery('viewContainers.catalog', {}, { enabled: isOpen }).data;
    /**
     * Shares the PrimarySidebar's polled snapshot, so the palette offers Open Pull Request exactly when the row shows a
     * glyph. `staleTime: Infinity` keeps this observer from refetching on open: the sidebar's poll owns freshness, and
     * a palette open must not pull the Server's `gh` sweep forward.
     */
    const pullRequests = useCaxriQuery('session.pullRequests', undefined, {
        enabled: isOpen,
        staleTime: Infinity,
    }).data;
    const sessions = activeSessionsInSidebarOrder(projects, useSessions() ?? NO_RECORDS);
    const selectedSession = useSelectedSession();
    const terminals = useTerminals();
    const whenContext = {
        sessionHasLiveAgent:
            selectedSession !== undefined && hasLiveAgentTerminal(selectedSession.id, terminals),
        sessionHasDetachedAgent:
            selectedSession !== undefined &&
            hasDetachedAgentTerminal(selectedSession.id, terminals),
        sessionHasPullRequest:
            selectedSession !== undefined &&
            pullRequests?.pullRequests[selectedSession.id] !== undefined,
    };
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <PickerDialogContent>
                <DialogTitle className="sr-only">Command Palette</DialogTitle>
                <Command label="Command Palette" className="w-full">
                    <CommandInput
                        autoFocus
                        placeholder="Search projects, sessions, and commands…"
                    />
                    <CommandList>
                        <CommandEmpty>No Project, Session, or command found.</CommandEmpty>
                        <CommandGroup heading="Projects">
                            {projectResults.map((project) => (
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
                                command.requiresArguments ||
                                !isCommandVisibleInPalette(command, whenContext) ? null : (
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
            </PickerDialogContent>
        </Dialog>
    );
}

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
import { useTranslation } from '../../i18n';
import { commandCategory, commandDescription, commandTitle } from '../../lib/command-labels';
import { useCommandShortcut } from '../../lib/keybindings';
import { useCaxriQuery } from '../../queries/client';
import { setPaletteOpen, useDialogStore } from '../../stores/dialogs';
import { useIsLocalOnlyAvailable, useIsRemote } from '../../stores/environment';
import { useProjects, useSelectedSession, useSessions, useTerminals } from '../../stores/selectors';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import { activeSessionsInSidebarOrder } from '../session/session-activity-order';
import { hasDetachedAgentTerminal, hasLiveAgentTerminal } from '../session/session-agent-commands';
import {
    didSelectSession,
    selectProject,
    SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
} from '../session/session-commands';
import { sessionTitleForDisplay } from '../session/session-title';
import { canRestartResumeAgent } from '../terminal/agent-restart-commands';
import { didExecuteViewCatalogCommand } from '../view-containers/view-container-commands';
import { useActivePaneTab } from '../workbench/pane-actions';
import type { CommandTitleContext } from './command-palette-commands';
import {
    getDynamicCommandPaletteValue,
    getPaletteExtensionCommands,
    getStaticCommandPaletteValue,
    isCommandVisibleInPalette,
    paletteCommandTitle,
} from './command-palette-commands';

const NO_RECORDS: never[] = [];

const commandItemMetaClassName = 'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * Every command already carries a plain-language `description` in the shared catalog (e.g. Screencast Mode's explains
 * it overlays clicks/keystrokes without hiding anything), but nothing in the palette ever rendered it. Showing it as a
 * secondary line benefits every command, not just the ones whose title alone is ambiguous.
 */
function CommandRow({
    command,
    titleContext,
}: {
    command: (typeof commandDefinitions)[number];
    titleContext: CommandTitleContext;
}) {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut(command.id);
    return (
        <CommandItem
            value={getStaticCommandPaletteValue(command, t, titleContext)}
            onSelect={() => {
                setPaletteOpen(false);
                executeCommand(command.id);
            }}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span>{paletteCommandTitle(command, titleContext, t)}</span>
                <span className="truncate text-[11px] text-muted">
                    {commandDescription(command, t)}
                </span>
            </span>
            <small className={commandItemMetaClassName}>
                {commandCategory(command.category, t)}
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
    const { t } = useTranslation();
    return (
        <CommandItem
            value={getDynamicCommandPaletteValue(command, t)}
            onSelect={() => {
                setPaletteOpen(false);
                didExecuteViewCatalogCommand(catalog, command.id);
            }}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span>{commandTitle(command, t)}</span>
                {command.description && (
                    <span className="truncate text-[11px] text-muted">{command.description}</span>
                )}
            </span>
            <small className={commandItemMetaClassName}>{t('palette.source.extension')}</small>
        </CommandItem>
    );
}

/**
 * The palette is mounted for the app's lifetime, so only its open flag is read here. Base UI's Portal renders nothing
 * while the dialog is closed, so the body's store reads and result derivations only run while it is open: the Session
 * ordering and the live/detached-agent checks below scan every Terminal, which the Workbench updates several times a
 * second while an agent runs. The Server queries were already gated on `isOpen`; this puts the local work on the same
 * footing.
 */
export function CommandPalette() {
    const isOpen = useDialogStore((state) => state.paletteOpen);
    return (
        <Dialog open={isOpen} onOpenChange={setPaletteOpen}>
            <PickerDialogContent>
                <CommandPaletteBody />
            </PickerDialogContent>
        </Dialog>
    );
}

function CommandPaletteBody() {
    const { t } = useTranslation();
    const onOpenChange = setPaletteOpen;
    const projects = useProjects() ?? NO_RECORDS;
    /**
     * Only the Projects group filters. Selecting an auto-registered worktree Project does nothing (it can never own a
     * Session) so offering it is a dead result. Session ordering and the Session subtitles below stay on the full list,
     * or a Session working in a worktree would lose its Project name.
     */
    const projectResults = topLevelProjects(projects);
    const catalog = useCaxriQuery('viewContainers.catalog', {}).data;
    /**
     * Shares the PrimarySidebar's polled snapshot, so the palette offers Open Pull Request exactly when the row shows a
     * glyph. The `staleTime` matches the sidebar's poll cadence so an open never pulls the Server's `gh` sweep forward
     * while the sidebar is mounted, yet a hidden sidebar still leaves the palette refreshing at that same rate.
     */
    const pullRequests = useCaxriQuery('session.pullRequests', undefined, {
        staleTime: SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
    }).data;
    const sessions = activeSessionsInSidebarOrder(projects, useSessions() ?? NO_RECORDS);
    const selectedSession = useSelectedSession();
    const terminals = useTerminals();
    const activeResource = useActivePaneTab()?.resource;
    const activeTerminal =
        activeResource?.kind === 'terminal'
            ? terminals.find((terminal) => terminal.id === activeResource.terminalId)
            : undefined;
    const titleContext: CommandTitleContext = {
        activeTerminalRestartsAgent: canRestartResumeAgent(activeTerminal),
    };
    const isLocalOnlyAvailable = useIsLocalOnlyAvailable();
    const isRemote = useIsRemote();
    const whenContext = {
        localMachine: isLocalOnlyAvailable,
        sshHost: isRemote,
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
        <>
            <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
            <Command label={t('palette.title')} className="w-full">
                <CommandInput autoFocus placeholder={t('palette.searchPlaceholder')} />
                <CommandList>
                    <CommandEmpty>{t('palette.empty')}</CommandEmpty>
                    <CommandGroup heading={t('palette.group.projects')}>
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
                                <small className={commandItemMetaClassName}>
                                    {t('palette.source.project')}
                                </small>
                            </CommandItem>
                        ))}
                    </CommandGroup>
                    <CommandGroup heading={t('palette.group.sessions')}>
                        {sessions.map((session) => {
                            const project = projects.find((item) => item.id === session.projectId);
                            return (
                                <CommandItem
                                    key={session.id}
                                    // `cmdk` tracks the selected row by `value`, not by React key, so two
                                    // sessions sharing a title and project (e.g. two "Untitled" sessions
                                    // in one worktree) would both render as selected. The id keeps every
                                    // value unique without changing what the search matches on.
                                    value={`Session ${sessionTitleForDisplay(session.displayTitle, t)} ${session.displayTitle} ${project?.displayTitle ?? ''} ${project?.rootPath ?? ''} ${session.id}`}
                                    onSelect={() => {
                                        onOpenChange(false);
                                        // eslint-disable-next-line no-void -- intentional floating-promise discard, didSelectSession() reports its own errors
                                        void didSelectSession(session.id);
                                    }}
                                >
                                    <span>{sessionTitleForDisplay(session.displayTitle, t)}</span>
                                    <small className={commandItemMetaClassName}>
                                        {project?.displayTitle ?? t('palette.source.session')}
                                    </small>
                                </CommandItem>
                            );
                        })}
                    </CommandGroup>
                    <CommandGroup heading={t('palette.group.commands')}>
                        {commandDefinitions.map((command) =>
                            command.requiresArguments ||
                            !isCommandVisibleInPalette(command, whenContext) ? null : (
                                <CommandRow
                                    key={command.id}
                                    command={command}
                                    titleContext={titleContext}
                                />
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
        </>
    );
}

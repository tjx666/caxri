import { commandDefinitions } from '@caxri/protocol';

import { isCommandAvailable } from '../../commands/execute';
import { CommandItem } from '../../components/ui/command';
import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { useTranslation } from '../../i18n';
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
import { useActivePaneTab } from '../workbench/pane-actions';
import type { CommandTitleContext } from './command-palette-commands';
import {
    commanderPaletteWhenContext,
    getDynamicCommandPaletteValue,
    getPaletteExtensionCommands,
    getStaticCommandPaletteValue,
    isCommandVisibleInPalette,
} from './command-palette-commands';
import type { CommandPaletteEntry } from './command-palette-results';
import { CommandPaletteResults } from './command-palette-results';
import { commandItemMetaClassName, CommandRow, DynamicCommandRow } from './command-row';

const NO_RECORDS: never[] = [];

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
    /**
     * Read fresh on each open, as the Session row menu does: the Commander takes and returns Sessions without a
     * Workbench record change. The cache entry is the one the Session row markers share.
     */
    const managedSessionIds = useCaxriQuery(
        'commander.managedSessions',
        {},
        { enabled: isLocalOnlyAvailable, staleTime: 0 },
    ).data?.sessionIds;
    const whenContext = {
        ...commanderPaletteWhenContext({
            isLocalOnlyAvailable,
            managedSessionIds,
            selectedSessionId: selectedSession?.id,
        }),
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
        /**
         * Read once as the palette opens: the active tab cannot change while the palette holds focus, and the composer
         * registers its controls before the user can reach the palette.
         */
        agentChatModels: isCommandAvailable('agentChat.changeModel'),
        agentChatPermissionModes: isCommandAvailable('agentChat.changePermissionMode'),
        agentChatPlanMode: isCommandAvailable('agentChat.togglePlanMode'),
    };
    const projectEntries: CommandPaletteEntry[] = projectResults.map((project) => {
        const value = `${project.displayTitle} Project ${project.rootPath}`;
        return {
            id: `project:${project.id}`,
            value,
            content: (
                <CommandItem
                    value={value}
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
            ),
        };
    });
    const sessionEntries: CommandPaletteEntry[] = sessions.map((session) => {
        const project = projects.find((item) => item.id === session.projectId);
        /**
         * Cmdk selects by value, so the ID distinguishes Sessions with identical titles and Projects.
         */
        const value = `${sessionTitleForDisplay(session.displayTitle, t)} Session ${session.displayTitle} ${project?.displayTitle ?? ''} ${project?.rootPath ?? ''} ${session.id}`;
        return {
            id: `session:${session.id}`,
            value,
            content: (
                <CommandItem
                    value={value}
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
            ),
        };
    });
    const staticEntries: CommandPaletteEntry[] = commandDefinitions
        .filter(
            (command) =>
                !command.requiresArguments && isCommandVisibleInPalette(command, whenContext),
        )
        .map((command) => {
            const value = getStaticCommandPaletteValue(command, t, titleContext);
            return {
                id: `command:${command.id}`,
                value,
                content: <CommandRow command={command} titleContext={titleContext} value={value} />,
            };
        });
    const extensionEntries: CommandPaletteEntry[] = getPaletteExtensionCommands(catalog).map(
        (command) => {
            const value = getDynamicCommandPaletteValue(command, t);
            return {
                id: `extension:${command.id}`,
                value,
                content: <DynamicCommandRow catalog={catalog!} command={command} value={value} />,
            };
        },
    );
    return (
        <>
            <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
            <CommandPaletteResults
                groups={[
                    {
                        id: 'projects',
                        heading: t('palette.group.projects'),
                        entries: projectEntries,
                    },
                    {
                        id: 'sessions',
                        heading: t('palette.group.sessions'),
                        entries: sessionEntries,
                    },
                    {
                        id: 'commands',
                        heading: t('palette.group.commands'),
                        entries: [...staticEntries, ...extensionEntries],
                    },
                ]}
            />
        </>
    );
}

import type { CommanderAgent, CommandId } from '@caxri/protocol';
import { commandDefinitions, commanderAgentIds } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { paletteCommandTitle } from '../palette/command-palette-commands';
import type { CommanderBoardScope } from './commander-board';
import { setCommanderBoardScope, setCommanderBoardVisible } from './commander-board-store';
import { openWorkbenchSettings, stopCommander } from './commander-commands';
import { commanderAgentName, switchCommanderAgent } from './commander-data-commands';
import { openCommanderClearData, setCommanderPaletteOpen } from './commander-dialogs-store';
import { openCommanderHandover } from './commander-handover-store';
import { setCommanderInboxVisible } from './commander-inbox-store';
import type { CommanderKeyboardCommand } from './commander-shortcuts';
import { COMMANDER_KEYBOARD_COMMANDS, isCommanderCommandAvailable } from './commander-shortcuts';

/**
 * Palette groups in display order: what the Commander is and does, then the window's layout, then its Agent pane.
 */
export const commanderPaletteGroups = ['commander', 'view', 'agent'] as const;
type CommanderPaletteGroup = (typeof commanderPaletteGroups)[number];

/**
 * The facts the palette's rows depend on, read by the palette as it opens.
 */
export interface CommanderPaletteContext {
    /**
     * The Agent CLI the Commander Terminal runs, once it exists.
     */
    agent: CommanderAgent | undefined;
    boardScope: CommanderBoardScope;
    isBoardVisible: boolean;
    isInboxVisible: boolean;
    /**
     * Restart resumes the Commander's Agent conversation, so its row reads "Restart Agent".
     */
    canRestartAgent: boolean;
    /**
     * The Commander Terminal once `commander.ensure` resolved; the Agent pane's rows need it.
     */
    terminalId: string | undefined;
}

export type CommanderPaletteAction =
    | { kind: 'boardScope'; scope: CommanderBoardScope }
    | { kind: 'boardVisible'; isVisible: boolean }
    | { kind: 'clearData' }
    | { kind: 'handover' }
    | { kind: 'inboxVisible'; isVisible: boolean }
    | { kind: 'keyboard'; command: CommanderKeyboardCommand; terminalId: string }
    | { kind: 'openSettings' }
    | { kind: 'stop' }
    | { kind: 'switchAgent'; agent: CommanderAgent };

export interface CommanderPaletteCommand {
    /**
     * Unique within the palette; `cmdk` tracks the highlighted row by it.
     */
    id: string;
    group: CommanderPaletteGroup;
    title: string;
    /**
     * Extra words the filter matches but the row does not show, such as the other names users search for.
     */
    keywords: string;
    /**
     * The command whose live keybinding the row shows.
     */
    shortcut?: CommandId;
    action: CommanderPaletteAction;
}

/**
 * The palette lists every keyboard command of this window except the palette itself.
 */
const PALETTE_KEYBOARD_COMMANDS = (
    Object.keys(COMMANDER_KEYBOARD_COMMANDS) as CommanderKeyboardCommand[]
).filter((command) => command !== 'commandPalette.open');

/**
 * Every row the Commander window's palette offers right now. A row appears only when its action would do something: the
 * Agent the Commander already runs is not offered, a column toggle names the state it moves to, and the Agent pane's
 * rows wait for the Commander Terminal and follow the same availability as their shortcuts.
 */
export function commanderPaletteCommands(
    context: CommanderPaletteContext,
    t: Translate,
): CommanderPaletteCommand[] {
    const switchAgents = commanderAgentIds
        .filter((agent) => agent !== context.agent)
        .map((agent): CommanderPaletteCommand => ({
            id: `switchAgent.${agent}`,
            group: 'commander',
            title: t('agentCommander.palette.switchAgent', { agent: commanderAgentName(agent) }),
            keywords: t('agentCommander.palette.switchAgentKeywords'),
            action: { kind: 'switchAgent', agent },
        }));
    const sessions = t('agentCommander.window.sessionsLabel');
    const needsYou = t('agentCommander.window.needsYou');
    const keyboard = context.terminalId
        ? keyboardCommands(context.terminalId, context.canRestartAgent, t)
        : [];
    return [
        ...switchAgents,
        {
            id: 'handover',
            group: 'commander',
            title: t('agentCommander.palette.handover'),
            keywords: t('agentCommander.palette.handoverKeywords'),
            action: { kind: 'handover' },
        },
        {
            id: 'clearData',
            group: 'commander',
            title: t('agentCommander.palette.clearData'),
            keywords: t('agentCommander.palette.clearDataKeywords'),
            action: { kind: 'clearData' },
        },
        {
            id: 'openSettings',
            group: 'commander',
            title: t('agentCommander.palette.openSettings'),
            keywords: '',
            shortcut: 'settings.open',
            action: { kind: 'openSettings' },
        },
        {
            id: 'stop',
            group: 'commander',
            title: t('agentCommander.window.stop'),
            keywords: t('agentCommander.palette.stopKeywords'),
            action: { kind: 'stop' },
        },
        {
            id: 'boardVisible',
            group: 'view',
            title: t(
                context.isBoardVisible
                    ? 'agentCommander.window.hideColumn'
                    : 'agentCommander.window.showColumn',
                { column: sessions },
            ),
            keywords: t('agentCommander.palette.boardKeywords'),
            action: { kind: 'boardVisible', isVisible: !context.isBoardVisible },
        },
        {
            id: 'boardScope',
            group: 'view',
            title: t(
                context.boardScope === 'all'
                    ? 'agentCommander.palette.showCommanderSessions'
                    : 'agentCommander.palette.showAllSessions',
            ),
            keywords: t('agentCommander.palette.boardKeywords'),
            action: {
                kind: 'boardScope',
                scope: context.boardScope === 'all' ? 'commander' : 'all',
            },
        },
        {
            id: 'inboxVisible',
            group: 'view',
            title: t(
                context.isInboxVisible
                    ? 'agentCommander.window.hideColumn'
                    : 'agentCommander.window.showColumn',
                { column: needsYou },
            ),
            keywords: t('agentCommander.palette.inboxKeywords'),
            action: { kind: 'inboxVisible', isVisible: !context.isInboxVisible },
        },
        ...keyboard,
    ];
}

function keyboardCommands(
    terminalId: string,
    canRestartAgent: boolean,
    t: Translate,
): CommanderPaletteCommand[] {
    return PALETTE_KEYBOARD_COMMANDS.flatMap((command) => {
        const definition = commandDefinitions.find(({ id }) => id === command);
        if (!definition || !isCommanderCommandAvailable(command, terminalId)) return [];
        return [
            {
                id: command,
                group: 'agent' as const,
                title: paletteCommandTitle(
                    definition,
                    { activeTerminalRestartsAgent: canRestartAgent },
                    t,
                ),
                keywords: definition.title,
                shortcut: command,
                action: { kind: 'keyboard' as const, command, terminalId },
            },
        ];
    });
}

/**
 * Runs one palette row after closing the palette, so a dialog or menu the row opens is not stacked on it and focus
 * returns to the window first.
 */
export function runCommanderPaletteAction(
    action: CommanderPaletteAction,
    agent: CommanderAgent | undefined,
): void {
    setCommanderPaletteOpen(false);
    switch (action.kind) {
        case 'boardScope':
            setCommanderBoardScope(action.scope);
            setCommanderBoardVisible(true);
            return;
        case 'boardVisible':
            setCommanderBoardVisible(action.isVisible);
            return;
        case 'clearData':
            openCommanderClearData();
            return;
        case 'handover':
            openCommanderHandover();
            return;
        case 'inboxVisible':
            setCommanderInboxVisible(action.isVisible);
            return;
        case 'keyboard':
            COMMANDER_KEYBOARD_COMMANDS[action.command].run(action.terminalId);
            return;
        case 'openSettings':
            openWorkbenchSettings();
            return;
        case 'stop':
            stopCommander();
            return;
        case 'switchAgent':
            // eslint-disable-next-line no-void -- the switch reports its own failure through a toast
            void switchCommanderAgent(agent, action.agent);
    }
}

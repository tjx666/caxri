import type { BotAgent, CommandId } from '@caxri/protocol';
import { botAgentIds, commandDefinitions } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { paletteCommandTitle } from '../palette/command-palette-commands';
import type { BotBoardScope } from './bot-board';
import { setBotBoardScope, setBotBoardVisible } from './bot-board-store';
import { openWorkbenchSettings, stopBot } from './bot-commands';
import { botAgentName, switchBotAgent } from './bot-data-commands';
import { openBotClearData, setBotPaletteOpen } from './bot-dialogs-store';
import { openBotHandover } from './bot-handover-store';
import { setBotInboxVisible } from './bot-inbox-store';
import type { BotKeyboardCommand } from './bot-shortcuts';
import { BOT_KEYBOARD_COMMANDS, isBotCommandAvailable } from './bot-shortcuts';

/**
 * Palette groups in display order: what Caxri Bot is and does, then the window's layout, then its Agent pane.
 */
export const botPaletteGroups = ['bot', 'view', 'agent'] as const;
type BotPaletteGroup = (typeof botPaletteGroups)[number];

/**
 * The facts the palette's rows depend on, read by the palette as it opens.
 */
export interface BotPaletteContext {
    /**
     * The Agent CLI Caxri Bot's Terminal runs, once it exists.
     */
    agent: BotAgent | undefined;
    boardScope: BotBoardScope;
    isBoardVisible: boolean;
    isInboxVisible: boolean;
    /**
     * Restart resumes Caxri Bot's Agent conversation, so its row reads "Restart Agent".
     */
    canRestartAgent: boolean;
    /**
     * Caxri Bot's Terminal once `bot.ensure` resolved; the Agent pane's rows need it.
     */
    terminalId: string | undefined;
}

export type BotPaletteAction =
    | { kind: 'boardScope'; scope: BotBoardScope }
    | { kind: 'boardVisible'; isVisible: boolean }
    | { kind: 'clearData' }
    | { kind: 'handover' }
    | { kind: 'inboxVisible'; isVisible: boolean }
    | { kind: 'keyboard'; command: BotKeyboardCommand; terminalId: string }
    | { kind: 'openSettings' }
    | { kind: 'stop' }
    | { kind: 'switchAgent'; agent: BotAgent };

export interface BotPaletteCommand {
    /**
     * Unique within the palette; `cmdk` tracks the highlighted row by it.
     */
    id: string;
    group: BotPaletteGroup;
    title: string;
    /**
     * Extra words the filter matches but the row does not show, such as the other names users search for.
     */
    keywords: string;
    /**
     * The command whose live keybinding the row shows.
     */
    shortcut?: CommandId;
    action: BotPaletteAction;
}

/**
 * The palette lists every keyboard command of this window except the palette itself.
 */
const PALETTE_KEYBOARD_COMMANDS = (
    Object.keys(BOT_KEYBOARD_COMMANDS) as BotKeyboardCommand[]
).filter((command) => command !== 'commandPalette.open');

/**
 * Every row the Caxri Bot window's palette offers right now. A row appears only when its action would do something: the
 * Agent Caxri Bot already runs is not offered, a column toggle names the state it moves to, and the Agent pane's rows
 * wait for Caxri Bot's Terminal and follow the same availability as their shortcuts.
 */
export function botPaletteCommands(context: BotPaletteContext, t: Translate): BotPaletteCommand[] {
    const switchAgents = botAgentIds
        .filter((agent) => agent !== context.agent)
        .map((agent): BotPaletteCommand => ({
            id: `switchAgent.${agent}`,
            group: 'bot',
            title: t('caxriBot.palette.switchAgent', { agent: botAgentName(agent) }),
            keywords: t('caxriBot.palette.switchAgentKeywords'),
            action: { kind: 'switchAgent', agent },
        }));
    const sessions = t('caxriBot.window.sessionsLabel');
    const needsYou = t('caxriBot.window.needsYou');
    const keyboard = context.terminalId
        ? keyboardCommands(context.terminalId, context.canRestartAgent, t)
        : [];
    return [
        ...switchAgents,
        {
            id: 'handover',
            group: 'bot',
            title: t('caxriBot.palette.handover'),
            keywords: t('caxriBot.palette.handoverKeywords'),
            action: { kind: 'handover' },
        },
        {
            id: 'clearData',
            group: 'bot',
            title: t('caxriBot.palette.clearData'),
            keywords: t('caxriBot.palette.clearDataKeywords'),
            action: { kind: 'clearData' },
        },
        {
            id: 'openSettings',
            group: 'bot',
            title: t('caxriBot.palette.openSettings'),
            keywords: '',
            shortcut: 'settings.open',
            action: { kind: 'openSettings' },
        },
        {
            id: 'stop',
            group: 'bot',
            title: t('caxriBot.window.stop'),
            keywords: t('caxriBot.palette.stopKeywords'),
            action: { kind: 'stop' },
        },
        {
            id: 'boardVisible',
            group: 'view',
            title: t(
                context.isBoardVisible
                    ? 'caxriBot.window.hideColumn'
                    : 'caxriBot.window.showColumn',
                { column: sessions },
            ),
            keywords: t('caxriBot.palette.boardKeywords'),
            action: { kind: 'boardVisible', isVisible: !context.isBoardVisible },
        },
        {
            id: 'boardScope',
            group: 'view',
            title: t(
                context.boardScope === 'all'
                    ? 'caxriBot.palette.showBotSessions'
                    : 'caxriBot.palette.showAllSessions',
            ),
            keywords: t('caxriBot.palette.boardKeywords'),
            action: {
                kind: 'boardScope',
                scope: context.boardScope === 'all' ? 'bot' : 'all',
            },
        },
        {
            id: 'inboxVisible',
            group: 'view',
            title: t(
                context.isInboxVisible
                    ? 'caxriBot.window.hideColumn'
                    : 'caxriBot.window.showColumn',
                { column: needsYou },
            ),
            keywords: t('caxriBot.palette.inboxKeywords'),
            action: { kind: 'inboxVisible', isVisible: !context.isInboxVisible },
        },
        ...keyboard,
    ];
}

function keyboardCommands(
    terminalId: string,
    canRestartAgent: boolean,
    t: Translate,
): BotPaletteCommand[] {
    return PALETTE_KEYBOARD_COMMANDS.flatMap((command) => {
        const definition = commandDefinitions.find(({ id }) => id === command);
        if (!definition || !isBotCommandAvailable(command, terminalId)) return [];
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
export function runBotPaletteAction(action: BotPaletteAction, agent: BotAgent | undefined): void {
    setBotPaletteOpen(false);
    switch (action.kind) {
        case 'boardScope':
            setBotBoardScope(action.scope);
            setBotBoardVisible(true);
            return;
        case 'boardVisible':
            setBotBoardVisible(action.isVisible);
            return;
        case 'clearData':
            openBotClearData();
            return;
        case 'handover':
            openBotHandover();
            return;
        case 'inboxVisible':
            setBotInboxVisible(action.isVisible);
            return;
        case 'keyboard':
            BOT_KEYBOARD_COMMANDS[action.command].run(action.terminalId);
            return;
        case 'openSettings':
            openWorkbenchSettings();
            return;
        case 'stop':
            stopBot();
            return;
        case 'switchAgent':
            void switchBotAgent(agent, action.agent);
    }
}

import { commands as enCommands } from '@desktop-shared/i18n/en/commands';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DataCommands from '../bot-data-commands';

const mocks = vi.hoisted(() => ({ ran: [] as string[] }));

vi.mock('../../terminal/terminal-commands', () => ({
    restartActiveTerminal: (terminalId: string) => mocks.ran.push(`restart ${terminalId}`),
}));
vi.mock('../../terminal/terminal-pane-handlers', () => ({
    clearActiveTerminal: (terminalId: string) => mocks.ran.push(`clear ${terminalId}`),
    findInActiveTerminal: (terminalId: string) => mocks.ran.push(`find ${terminalId}`),
}));
vi.mock('../../terminal/terminal-link-actions', () => ({
    openTerminalLinkPicker: (terminalId: string) => mocks.ran.push(`links ${terminalId}`),
}));
vi.mock('../../terminal/terminal-surface-commands', () => ({
    switchTerminalToOtherSurface: (terminalId: string) => mocks.ran.push(`surface ${terminalId}`),
}));
vi.mock('../bot-commands', () => ({
    openWorkbenchSettings: () => mocks.ran.push('settings'),
    stopBot: () => mocks.ran.push('stop'),
}));
vi.mock('../bot-data-commands', async (importOriginal) => ({
    ...(await importOriginal<typeof DataCommands>()),
    switchBotAgent: (current: string | undefined, next: string) => {
        mocks.ran.push(`switch ${current} -> ${next}`);
        return Promise.resolve();
    },
}));

import type { Translate } from '../../../i18n';
import { withLocale } from '../../../i18n';
import { caxriBot as enCaxriBot } from '../../../i18n/locales/en/caxri-bot';
import { terminal as enTerminal } from '../../../i18n/locales/en/terminal';
import { useDialogStore } from '../../../stores/dialogs';
import { setBotBoardVisible, useBotBoardUiStore } from '../bot-board-store';
import {
    closeBotClearData,
    openBotClearData,
    requestBotPalette,
    setBotPaletteOpen,
    useBotDialogsStore,
} from '../bot-dialogs-store';
import type { BotPaletteContext } from '../bot-palette';
import { botPaletteCommands, runBotPaletteAction } from '../bot-palette';

const english: Readonly<Record<string, string>> = {
    ...enCommands,
    ...enTerminal,
    ...enCaxriBot,
};
const t: Translate = withLocale((key, parameters) =>
    (english[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(parameters?.[name] ?? ''),
    ),
);

const context: BotPaletteContext = {
    agent: 'codex',
    boardScope: 'bot',
    isBoardVisible: true,
    isInboxVisible: false,
    canRestartAgent: true,
    terminalId: 'terminal-1',
};

function titles(overrides: Partial<BotPaletteContext> = {}): string[] {
    return botPaletteCommands({ ...context, ...overrides }, t).map(({ title }) => title);
}

beforeEach(() => {
    mocks.ran.length = 0;
});

describe('botPaletteCommands', () => {
    it('offers only the Agents Caxri Bot does not already run', () => {
        expect(titles()).toContain('Switch Caxri Bot to Claude');
        expect(titles()).not.toContain('Switch Caxri Bot to Codex');
        expect(titles({ agent: 'claude' })).toContain('Switch Caxri Bot to Codex');
    });

    it('names the state each column toggle moves to', () => {
        expect(titles()).toEqual(expect.arrayContaining(['Hide Sessions', 'Show Needs you']));
        expect(titles({ isBoardVisible: false, isInboxVisible: true })).toEqual(
            expect.arrayContaining(['Show Sessions', 'Hide Needs you']),
        );
        expect(titles({ boardScope: 'all' })).toContain('Show Only Caxri Bot Sessions');
        expect(titles()).toContain('Show Every Session');
    });

    it("lists the Agent pane commands once Caxri Bot's Terminal exists, never the palette itself", () => {
        const rows = botPaletteCommands(context, t);
        expect(rows.find(({ id }) => id === 'terminal.find')).toMatchObject({
            group: 'agent',
            shortcut: 'terminal.find',
        });
        expect(rows.some(({ id }) => id === 'commandPalette.open')).toBe(false);
        expect(titles()).toContain('Restart Agent');
        expect(
            botPaletteCommands({ ...context, terminalId: undefined }, t).some(
                ({ group }) => group === 'agent',
            ),
        ).toBe(false);
    });

    it('gives every row a unique id, since the palette tracks the highlighted row by it', () => {
        const ids = botPaletteCommands(context, t).map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('requestBotPalette', () => {
    it('leaves an open dialog alone and opens the palette once it closed', () => {
        useDialogStore.getState().registerModal('clear-data');
        requestBotPalette();
        expect(useBotDialogsStore.getState().isPaletteOpen).toBe(false);

        useDialogStore.getState().unregisterModal('clear-data');
        requestBotPalette();
        expect(useBotDialogsStore.getState().isPaletteOpen).toBe(true);
        setBotPaletteOpen(false);
    });
});

describe('closeBotClearData', () => {
    it('lets a late clear close only the dialog it was submitted from', () => {
        openBotClearData();
        const submittedFrom = useBotDialogsStore.getState().clearDataRequestId;
        closeBotClearData();
        openBotClearData();

        const reopened = useBotDialogsStore.getState().clearDataRequestId;
        expect(reopened).not.toBe(submittedFrom);

        closeBotClearData(submittedFrom);
        expect(useBotDialogsStore.getState().clearDataRequestId).toBe(reopened);
        closeBotClearData(reopened);
        expect(useBotDialogsStore.getState().clearDataRequestId).toBeUndefined();
    });
});

describe('runBotPaletteAction', () => {
    it('closes the palette before the row runs', () => {
        setBotPaletteOpen(true);
        runBotPaletteAction({ kind: 'stop' }, 'codex');
        expect(useBotDialogsStore.getState().isPaletteOpen).toBe(false);
        expect(mocks.ran).toEqual(['stop']);
    });

    it('shows the board when the row changes its scope', () => {
        setBotBoardVisible(false);
        runBotPaletteAction({ kind: 'boardScope', scope: 'all' }, 'codex');
        expect(useBotBoardUiStore.getState()).toMatchObject({
            scope: 'all',
            isVisible: true,
        });
    });

    it('opens Clear Caxri Bot Data as a fresh request', () => {
        const before = useBotDialogsStore.getState().lastClearDataRequestId;
        runBotPaletteAction({ kind: 'clearData' }, 'codex');
        expect(useBotDialogsStore.getState().clearDataRequestId).toBe(before + 1);
    });

    it("runs the Agent pane command on Caxri Bot's Terminal and switches from the current Agent", () => {
        runBotPaletteAction(
            { kind: 'keyboard', command: 'terminal.find', terminalId: 'terminal-1' },
            'codex',
        );
        runBotPaletteAction({ kind: 'switchAgent', agent: 'claude' }, 'codex');
        expect(mocks.ran).toEqual(['find terminal-1', 'switch codex -> claude']);
    });
});

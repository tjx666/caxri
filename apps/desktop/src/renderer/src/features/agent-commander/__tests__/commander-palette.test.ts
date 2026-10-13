import { commands as enCommands } from '@desktop-shared/i18n/en/commands';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DataCommands from '../commander-data-commands';

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
vi.mock('../commander-commands', () => ({
    openWorkbenchSettings: () => mocks.ran.push('settings'),
    stopCommander: () => mocks.ran.push('stop'),
}));
vi.mock('../commander-data-commands', async (importOriginal) => ({
    ...(await importOriginal<typeof DataCommands>()),
    switchCommanderAgent: (current: string | undefined, next: string) => {
        mocks.ran.push(`switch ${current} -> ${next}`);
        return Promise.resolve();
    },
}));

import type { Translate } from '../../../i18n';
import { agentCommander as enAgentCommander } from '../../../i18n/locales/en/agent-commander';
import { terminal as enTerminal } from '../../../i18n/locales/en/terminal';
import { useDialogStore } from '../../../stores/dialogs';
import { setCommanderBoardVisible, useCommanderBoardUiStore } from '../commander-board-store';
import {
    closeCommanderClearData,
    openCommanderClearData,
    requestCommanderPalette,
    setCommanderPaletteOpen,
    useCommanderDialogsStore,
} from '../commander-dialogs-store';
import type { CommanderPaletteContext } from '../commander-palette';
import { commanderPaletteCommands, runCommanderPaletteAction } from '../commander-palette';

const english: Readonly<Record<string, string>> = {
    ...enCommands,
    ...enTerminal,
    ...enAgentCommander,
};
const t: Translate = (key, parameters) =>
    (english[key] ?? key).replaceAll(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(parameters?.[name] ?? ''),
    );

const context: CommanderPaletteContext = {
    agent: 'codex',
    boardScope: 'commander',
    isBoardVisible: true,
    isInboxVisible: false,
    canRestartAgent: true,
    terminalId: 'terminal-1',
};

function titles(overrides: Partial<CommanderPaletteContext> = {}): string[] {
    return commanderPaletteCommands({ ...context, ...overrides }, t).map(({ title }) => title);
}

beforeEach(() => {
    mocks.ran.length = 0;
});

describe('commanderPaletteCommands', () => {
    it('offers only the Agents the Commander does not already run', () => {
        expect(titles()).toContain('Switch the Commander to Claude');
        expect(titles()).not.toContain('Switch the Commander to Codex');
        expect(titles({ agent: 'claude' })).toContain('Switch the Commander to Codex');
    });

    it('names the state each column toggle moves to', () => {
        expect(titles()).toEqual(expect.arrayContaining(['Hide Sessions', 'Show Needs you']));
        expect(titles({ isBoardVisible: false, isInboxVisible: true })).toEqual(
            expect.arrayContaining(['Show Sessions', 'Hide Needs you']),
        );
        expect(titles({ boardScope: 'all' })).toContain('Show Only Commander Sessions');
        expect(titles()).toContain('Show Every Session');
    });

    it('lists the Agent pane commands once the Commander Terminal exists, never the palette itself', () => {
        const rows = commanderPaletteCommands(context, t);
        expect(rows.find(({ id }) => id === 'terminal.find')).toMatchObject({
            group: 'agent',
            shortcut: 'terminal.find',
        });
        expect(rows.some(({ id }) => id === 'commandPalette.open')).toBe(false);
        expect(titles()).toContain('Restart Agent');
        expect(
            commanderPaletteCommands({ ...context, terminalId: undefined }, t).some(
                ({ group }) => group === 'agent',
            ),
        ).toBe(false);
    });

    it('gives every row a unique id, since the palette tracks the highlighted row by it', () => {
        const ids = commanderPaletteCommands(context, t).map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('requestCommanderPalette', () => {
    it('leaves an open dialog alone and opens the palette once it closed', () => {
        useDialogStore.getState().registerModal('clear-data');
        requestCommanderPalette();
        expect(useCommanderDialogsStore.getState().isPaletteOpen).toBe(false);

        useDialogStore.getState().unregisterModal('clear-data');
        requestCommanderPalette();
        expect(useCommanderDialogsStore.getState().isPaletteOpen).toBe(true);
        setCommanderPaletteOpen(false);
    });
});

describe('closeCommanderClearData', () => {
    it('lets a late clear close only the dialog it was submitted from', () => {
        openCommanderClearData();
        const submittedFrom = useCommanderDialogsStore.getState().clearDataRequestId;
        closeCommanderClearData();
        openCommanderClearData();

        const reopened = useCommanderDialogsStore.getState().clearDataRequestId;
        expect(reopened).not.toBe(submittedFrom);

        closeCommanderClearData(submittedFrom);
        expect(useCommanderDialogsStore.getState().clearDataRequestId).toBe(reopened);
        closeCommanderClearData(reopened);
        expect(useCommanderDialogsStore.getState().clearDataRequestId).toBeUndefined();
    });
});

describe('runCommanderPaletteAction', () => {
    it('closes the palette before the row runs', () => {
        setCommanderPaletteOpen(true);
        runCommanderPaletteAction({ kind: 'stop' }, 'codex');
        expect(useCommanderDialogsStore.getState().isPaletteOpen).toBe(false);
        expect(mocks.ran).toEqual(['stop']);
    });

    it('shows the board when the row changes its scope', () => {
        setCommanderBoardVisible(false);
        runCommanderPaletteAction({ kind: 'boardScope', scope: 'all' }, 'codex');
        expect(useCommanderBoardUiStore.getState()).toMatchObject({
            scope: 'all',
            isVisible: true,
        });
    });

    it('opens Clear Commander Data as a fresh request', () => {
        const before = useCommanderDialogsStore.getState().lastClearDataRequestId;
        runCommanderPaletteAction({ kind: 'clearData' }, 'codex');
        expect(useCommanderDialogsStore.getState().clearDataRequestId).toBe(before + 1);
    });

    it('runs the Agent pane command on the Commander Terminal and switches from the current Agent', () => {
        runCommanderPaletteAction(
            { kind: 'keyboard', command: 'terminal.find', terminalId: 'terminal-1' },
            'codex',
        );
        runCommanderPaletteAction({ kind: 'switchAgent', agent: 'claude' }, 'codex');
        expect(mocks.ran).toEqual(['find terminal-1', 'switch codex -> claude']);
    });
});

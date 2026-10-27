import type { BootstrapState, Keybinding } from '@caxri/protocol';
import { defaultKeybindings } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { commandDefinitions } from '../../../commands/definitions';
import { useDialogStore } from '../../../stores/dialogs';
import { useWorkbenchStore } from '../../../stores/workbench';
import { registerAgentChatComposerCommand } from '../../agent-chat/composer/agent-chat-composer-commands';
import { setBotPaletteOpen, useBotDialogsStore } from '../bot-dialogs-store';
import {
    BOT_KEYBOARD_COMMANDS,
    createBotShortcutState,
    dispatchBotKeydown,
} from '../bot-shortcuts';

/**
 * The focused input of a running xterm, which matches both the Terminal and the editable-surface selectors.
 */
const TERMINAL_TARGET = {
    closest: (selector: string) => (selector.split(', ').includes('.xterm') ? {} : null),
};

function keydown(
    key: string,
    modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'shiftKey'>> = {},
    target: unknown = TERMINAL_TARGET,
) {
    const event = {
        altKey: false,
        code: '',
        ctrlKey: false,
        isComposing: false,
        key,
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
        stopPropagation: vi.fn(),
        target,
        ...modifiers,
    };
    return event as typeof event & KeyboardEvent;
}

function useKeybindings(keybindings: readonly Keybinding[]): void {
    useWorkbenchStore.setState({ bootstrap: { keybindings } as unknown as BootstrapState });
}

beforeEach(() => {
    mocks.ran.length = 0;
    useKeybindings(defaultKeybindings);
});

afterEach(() => {
    useWorkbenchStore.setState({ bootstrap: undefined });
    for (const id of useDialogStore.getState().openModalIds)
        useDialogStore.getState().unregisterModal(id);
});

describe('Caxri Bot shortcuts', () => {
    it('reaches through an editable target exactly when the Workbench definition does', () => {
        const botIds = Object.keys(BOT_KEYBOARD_COMMANDS);
        expect(botIds.length).toBeGreaterThan(0);
        for (const [id, { allowInEditable }] of Object.entries(BOT_KEYBOARD_COMMANDS)) {
            const workbench = commandDefinitions.find((definition) => definition.id === id);
            expect(workbench, `${id} has a Workbench definition`).toBeDefined();
            expect({ id, allowInEditable }).toEqual({
                id,
                allowInEditable: workbench?.allowInEditable ?? false,
            });
        }
    });

    it("runs the Terminal actions its context menu offers on Caxri Bot's Terminal", () => {
        const state = createBotShortcutState();

        dispatchBotKeydown(state, keydown('f', { metaKey: true }), 'terminal-1');
        dispatchBotKeydown(state, keydown('k', { metaKey: true, shiftKey: true }), 'terminal-1');
        dispatchBotKeydown(state, keydown('o', { metaKey: true, shiftKey: true }), 'terminal-1');
        // A stopped Terminal gives up focus.
        dispatchBotKeydown(
            state,
            keydown('r', { metaKey: true, shiftKey: true }, null),
            'terminal-1',
        );

        expect(mocks.ran).toEqual([
            'find terminal-1',
            'clear terminal-1',
            'links terminal-1',
            'restart terminal-1',
        ]);
    });

    it('opens its own Command Palette from a chord the user moved off the native menu', () => {
        useKeybindings([
            { key: 'cmd+k cmd+p', command: 'commandPalette.open' },
            ...defaultKeybindings.filter(({ command }) => command !== 'commandPalette.open'),
        ]);
        const state = createBotShortcutState();

        dispatchBotKeydown(state, keydown('k', { metaKey: true }), 'terminal-1');
        dispatchBotKeydown(state, keydown('p', { metaKey: true }), 'terminal-1');

        expect(useBotDialogsStore.getState().isPaletteOpen).toBe(true);
        setBotPaletteOpen(false);
    });

    it('switches Caxri Bot between Terminal and Chat, even from the focused Chat composer', () => {
        dispatchBotKeydown(
            createBotShortcutState(),
            keydown('j', { metaKey: true, shiftKey: true }, { closest: () => ({}) }),
            'terminal-1',
        );

        expect(mocks.ran).toEqual(['surface terminal-1']);
    });

    it("opens Caxri Bot Chat's menus from its composer, and leaves the chord alone without a Chat", () => {
        const composer = { closest: () => ({}) };
        const withoutChat = keydown('/', { metaKey: true }, composer);
        dispatchBotKeydown(createBotShortcutState(), withoutChat, 'terminal-1');
        expect(withoutChat.preventDefault).not.toHaveBeenCalled();

        const unregister = registerAgentChatComposerCommand('terminal-1', 'changeModel', () =>
            mocks.ran.push('model terminal-1'),
        );
        try {
            const withChat = keydown('/', { metaKey: true }, composer);
            dispatchBotKeydown(createBotShortcutState(), withChat, 'terminal-1');
            expect(withChat.preventDefault).toHaveBeenCalled();
        } finally {
            unregister();
        }
        expect(mocks.ran).toEqual(['model terminal-1']);
    });

    it('leaves every Workbench command and chord to the focused surface', () => {
        const state = createBotShortcutState();
        const newTerminal = keydown('t', { metaKey: true });
        const chordStart = keydown('k', { metaKey: true });
        const typedAfterChordStart = keydown('s');

        dispatchBotKeydown(state, newTerminal, 'terminal-1');
        dispatchBotKeydown(state, chordStart, 'terminal-1');
        dispatchBotKeydown(state, typedAfterChordStart, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(newTerminal.preventDefault).not.toHaveBeenCalled();
        expect(chordStart.preventDefault).not.toHaveBeenCalled();
        expect(typedAfterChordStart.preventDefault).not.toHaveBeenCalled();
    });

    it('leaves Restart to a running Terminal that has focus, as the Workbench does', () => {
        const restart = keydown('r', { metaKey: true, shiftKey: true });

        dispatchBotKeydown(createBotShortcutState(), restart, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(restart.preventDefault).not.toHaveBeenCalled();
    });

    it('keeps Terminal-focused bindings to the Terminal', () => {
        const clearOutsideTerminal = keydown('k', { metaKey: true, shiftKey: true }, null);

        dispatchBotKeydown(createBotShortcutState(), clearOutsideTerminal, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(clearOutsideTerminal.preventDefault).not.toHaveBeenCalled();
    });

    it('follows the keybindings the user set, including a sequence', () => {
        useKeybindings([
            { key: 'cmd+alt+f', command: 'terminal.find' },
            { key: 'cmd+k cmd+l', command: 'terminal.openDetectedLink' },
        ]);
        const state = createBotShortcutState();

        dispatchBotKeydown(state, keydown('f', { metaKey: true }), 'terminal-1');
        dispatchBotKeydown(state, keydown('f', { altKey: true, metaKey: true }), 'terminal-1');
        dispatchBotKeydown(state, keydown('k', { metaKey: true }), 'terminal-1');
        dispatchBotKeydown(state, keydown('l', { metaKey: true }), 'terminal-1');

        expect(mocks.ran).toEqual(['find terminal-1', 'links terminal-1']);
    });

    it('consumes a bound chord without running it while a dialog is open', () => {
        useDialogStore.getState().registerModal('confirmation');
        const find = keydown('f', { metaKey: true });

        dispatchBotKeydown(createBotShortcutState(), find, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(find.preventDefault).toHaveBeenCalledOnce();
    });

    it("stands down until Caxri Bot's Terminal exists", () => {
        const find = keydown('f', { metaKey: true });

        dispatchBotKeydown(createBotShortcutState(), find, undefined);

        expect(mocks.ran).toEqual([]);
        expect(find.preventDefault).not.toHaveBeenCalled();
    });
});

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
import {
    COMMANDER_TERMINAL_COMMANDS,
    createCommanderShortcutState,
    dispatchCommanderKeydown,
} from '../commander-shortcuts';

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

describe('Agent Commander shortcuts', () => {
    it('reaches through an editable target exactly when the Workbench definition does', () => {
        const commanderIds = Object.keys(COMMANDER_TERMINAL_COMMANDS);
        expect(commanderIds.length).toBeGreaterThan(0);
        for (const [id, { allowInEditable }] of Object.entries(COMMANDER_TERMINAL_COMMANDS)) {
            const workbench = commandDefinitions.find((definition) => definition.id === id);
            expect(workbench, `${id} has a Workbench definition`).toBeDefined();
            expect({ id, allowInEditable }).toEqual({
                id,
                allowInEditable: workbench?.allowInEditable ?? false,
            });
        }
    });

    it('runs the Terminal actions its context menu offers on the Commander Terminal', () => {
        const state = createCommanderShortcutState();

        dispatchCommanderKeydown(state, keydown('f', { metaKey: true }), 'terminal-1');
        dispatchCommanderKeydown(
            state,
            keydown('k', { metaKey: true, shiftKey: true }),
            'terminal-1',
        );
        dispatchCommanderKeydown(
            state,
            keydown('o', { metaKey: true, shiftKey: true }),
            'terminal-1',
        );
        // A stopped Terminal gives up focus.
        dispatchCommanderKeydown(
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

    it('switches the Commander between Terminal and Chat, even from the focused Chat composer', () => {
        dispatchCommanderKeydown(
            createCommanderShortcutState(),
            keydown('j', { metaKey: true, shiftKey: true }, { closest: () => ({}) }),
            'terminal-1',
        );

        expect(mocks.ran).toEqual(['surface terminal-1']);
    });

    it('leaves every Workbench command and chord to the focused surface', () => {
        const state = createCommanderShortcutState();
        const newTerminal = keydown('t', { metaKey: true });
        const chordStart = keydown('k', { metaKey: true });
        const typedAfterChordStart = keydown('s');

        dispatchCommanderKeydown(state, newTerminal, 'terminal-1');
        dispatchCommanderKeydown(state, chordStart, 'terminal-1');
        dispatchCommanderKeydown(state, typedAfterChordStart, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(newTerminal.preventDefault).not.toHaveBeenCalled();
        expect(chordStart.preventDefault).not.toHaveBeenCalled();
        expect(typedAfterChordStart.preventDefault).not.toHaveBeenCalled();
    });

    it('leaves Restart to a running Terminal that has focus, as the Workbench does', () => {
        const restart = keydown('r', { metaKey: true, shiftKey: true });

        dispatchCommanderKeydown(createCommanderShortcutState(), restart, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(restart.preventDefault).not.toHaveBeenCalled();
    });

    it('keeps Terminal-focused bindings to the Terminal', () => {
        const clearOutsideTerminal = keydown('k', { metaKey: true, shiftKey: true }, null);

        dispatchCommanderKeydown(
            createCommanderShortcutState(),
            clearOutsideTerminal,
            'terminal-1',
        );

        expect(mocks.ran).toEqual([]);
        expect(clearOutsideTerminal.preventDefault).not.toHaveBeenCalled();
    });

    it('follows the keybindings the user set, including a sequence', () => {
        useKeybindings([
            { key: 'cmd+alt+f', command: 'terminal.find' },
            { key: 'cmd+k cmd+l', command: 'terminal.openDetectedLink' },
        ]);
        const state = createCommanderShortcutState();

        dispatchCommanderKeydown(state, keydown('f', { metaKey: true }), 'terminal-1');
        dispatchCommanderKeydown(
            state,
            keydown('f', { altKey: true, metaKey: true }),
            'terminal-1',
        );
        dispatchCommanderKeydown(state, keydown('k', { metaKey: true }), 'terminal-1');
        dispatchCommanderKeydown(state, keydown('l', { metaKey: true }), 'terminal-1');

        expect(mocks.ran).toEqual(['find terminal-1', 'links terminal-1']);
    });

    it('consumes a bound chord without running it while a dialog is open', () => {
        useDialogStore.getState().registerModal('confirmation');
        const find = keydown('f', { metaKey: true });

        dispatchCommanderKeydown(createCommanderShortcutState(), find, 'terminal-1');

        expect(mocks.ran).toEqual([]);
        expect(find.preventDefault).toHaveBeenCalledOnce();
    });

    it('stands down until the Commander Terminal exists', () => {
        const find = keydown('f', { metaKey: true });

        dispatchCommanderKeydown(createCommanderShortcutState(), find, undefined);

        expect(mocks.ran).toEqual([]);
        expect(find.preventDefault).not.toHaveBeenCalled();
    });
});

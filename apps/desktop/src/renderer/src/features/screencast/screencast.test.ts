import type { Keybinding } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ScreencastKeyboardInput } from './screencast';
import {
    describeScreencastKey,
    screencastToggleToastMessage,
    useScreencastStore,
} from './screencast';

const keybindings: Keybinding[] = [
    { key: 'cmd+shift+k', command: 'terminal.clear' },
    { key: 'cmd+n', command: 'project.create' },
    { key: 'cmd+s', command: 'editor.save' },
    { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
];

function keyboardInput(
    key: string,
    overrides: Partial<ScreencastKeyboardInput> = {},
): ScreencastKeyboardInput {
    return {
        altKey: false,
        ctrlKey: false,
        isComposing: false,
        key,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe('describeScreencastKey', () => {
    it('labels an executable Caxri shortcut with its normalized chord and command title', () => {
        expect(
            describeScreencastKey(
                keyboardInput('k', { metaKey: true, shiftKey: true }),
                keybindings,
                {
                    commandAllowsEditable: () => true,
                    editable: false,
                    terminalFocus: false,
                },
            ),
        ).toEqual({ commandTitle: 'Clear Terminal', shortcut: 'cmd+shift+k' });
    });

    /**
     * Screencast looks bindings up a second time, so without the chord dispatch armed it captions the continuation of
     * `Cmd+K Cmd+S` with the unrelated single-chord `Cmd+S` command, announcing "Save" while the app opened Settings.
     */
    it('captions a chord continuation with the sequence that actually ran', () => {
        expect(
            describeScreencastKey(keyboardInput('s', { metaKey: true }), keybindings, {
                commandAllowsEditable: () => true,
                editable: false,
                leadingChord: 'cmd+k',
                terminalFocus: false,
            }),
        ).toEqual({ commandTitle: 'Open Keyboard Shortcuts', shortcut: 'cmd+k cmd+s' });
    });

    it('never exposes printable input or IME composition', () => {
        const options = {
            commandAllowsEditable: () => false,
            editable: true,
            terminalFocus: false,
        };

        expect(describeScreencastKey(keyboardInput('s'), keybindings, options)).toBeUndefined();
        expect(
            describeScreencastKey(
                keyboardInput('Process', { isComposing: true }),
                keybindings,
                options,
            ),
        ).toBeUndefined();
    });

    it('hides a bare printable key even when it is a valid editable command binding', () => {
        expect(
            describeScreencastKey(keyboardInput('p'), [{ key: 'p', command: 'terminal.clear' }], {
                commandAllowsEditable: () => true,
                editable: true,
                terminalFocus: false,
            }),
        ).toBeUndefined();
    });

    it('does not show a shortcut that command dispatch blocks in an editable surface', () => {
        expect(
            describeScreencastKey(keyboardInput('n', { metaKey: true }), keybindings, {
                commandAllowsEditable: () => false,
                editable: true,
                terminalFocus: false,
            }),
        ).toBeUndefined();
    });

    it('shows non-printable navigation keys only outside editable surfaces', () => {
        expect(
            describeScreencastKey(keyboardInput('Escape'), keybindings, {
                commandAllowsEditable: () => false,
                editable: false,
                terminalFocus: false,
            }),
        ).toEqual({ shortcut: 'escape' });
        expect(
            describeScreencastKey(keyboardInput('Escape'), keybindings, {
                commandAllowsEditable: () => false,
                editable: true,
                terminalFocus: false,
            }),
        ).toBeUndefined();
    });

    it('shows a terminalFocus shortcut only for a Terminal event target', () => {
        const binding: Keybinding = {
            args: { text: '\u{1B}[1;3B' },
            command: 'workbench.action.terminal.sendSequence',
            key: 'cmd+enter',
            when: 'terminalFocus',
        };
        const event = keyboardInput('Enter', { metaKey: true });
        const options = {
            commandAllowsEditable: () => true,
            editable: true,
            terminalFocus: false,
        };

        expect(describeScreencastKey(event, [binding], options)).toBeUndefined();
        expect(
            describeScreencastKey(event, [binding], { ...options, terminalFocus: true }),
        ).toEqual({ commandTitle: 'Send Sequence', shortcut: 'cmd+enter' });
    });
});

describe('screencastToggleToastMessage', () => {
    it('names the resulting state so the toast reads as a confirmation, not a command', () => {
        expect(screencastToggleToastMessage(true)).toBe('Screencast Mode on');
        expect(screencastToggleToastMessage(false)).toBe('Screencast Mode off');
    });
});

describe('useScreencastStore', () => {
    it('flips `enabled` on each toggle', () => {
        useScreencastStore.setState({ enabled: false });

        useScreencastStore.getState().toggle();
        expect(useScreencastStore.getState().enabled).toBe(true);

        useScreencastStore.getState().toggle();
        expect(useScreencastStore.getState().enabled).toBe(false);
    });
});

import type { Keybinding } from '@shared/types';
import { describe, expect, it } from 'vitest';

import type { ScreencastKeyboardInput } from './screencast';
import {
    describeScreencastKey,
    screencastToggleToastMessage,
    useScreencastStore,
} from './screencast';

const keybindings: Keybinding[] = [
    { key: 'cmd+k', command: 'terminal.clear' },
    { key: 'cmd+n', command: 'project.create' },
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
            describeScreencastKey(keyboardInput('k', { metaKey: true }), keybindings, {
                commandAllowsEditable: () => true,
                editable: false,
            }),
        ).toEqual({ commandTitle: 'Clear Terminal', shortcut: 'cmd+k' });
    });

    it('never exposes printable input or IME composition', () => {
        const options = { commandAllowsEditable: () => false, editable: true };

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
            }),
        ).toBeUndefined();
    });

    it('does not show a shortcut that command dispatch blocks in an editable surface', () => {
        expect(
            describeScreencastKey(keyboardInput('n', { metaKey: true }), keybindings, {
                commandAllowsEditable: () => false,
                editable: true,
            }),
        ).toBeUndefined();
    });

    it('shows non-printable navigation keys only outside editable surfaces', () => {
        expect(
            describeScreencastKey(keyboardInput('Escape'), keybindings, {
                commandAllowsEditable: () => false,
                editable: false,
            }),
        ).toEqual({ shortcut: 'escape' });
        expect(
            describeScreencastKey(keyboardInput('Escape'), keybindings, {
                commandAllowsEditable: () => false,
                editable: true,
            }),
        ).toBeUndefined();
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

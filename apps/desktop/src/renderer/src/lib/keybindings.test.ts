import { formatShortcut } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    ariaKeyShortcuts,
    buildShortcutMap,
    isKeybindingRecordingEventTarget,
    isModifierKey,
    keyboardEventShortcut,
    resolveShortcutBinding,
} from './keybindings';

/**
 * `keyboardEventShortcut` only reads `key`, `code`, and the four modifier flags, so a plain object is a faithful
 * stand-in and keeps the test free of a DOM environment.
 */
function keyEvent(init: {
    key: string;
    code?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
}): KeyboardEvent {
    return {
        key: init.key,
        code: init.code ?? '',
        altKey: init.altKey ?? false,
        ctrlKey: init.ctrlKey ?? false,
        metaKey: init.metaKey ?? false,
        shiftKey: init.shiftKey ?? false,
    } as KeyboardEvent;
}

describe('keyboardEventShortcut', () => {
    it('normalizes an ordinary command chord', () => {
        expect(keyboardEventShortcut(keyEvent({ key: 'P', code: 'KeyP', metaKey: true }))).toBe(
            'cmd+p',
        );
    });

    it('normalizes a Backquote command chord without renaming its printable key', () => {
        expect(
            keyboardEventShortcut(keyEvent({ key: '`', code: 'Backquote', metaKey: true })),
        ).toBe('cmd+`');
        expect(
            keyboardEventShortcut(
                keyEvent({
                    key: '~',
                    code: 'Backquote',
                    metaKey: true,
                    shiftKey: true,
                }),
            ),
        ).toBe('cmd+shift+~');
    });

    /**
     * Regression for the dead Option chords: macOS composes Option+P into `π`, so a chord built from `event.key` alone
     * produced `alt+π` and could never match a stored `alt+p`.
     */
    it('resolves an Option+letter chord from the physical key, not the composed character', () => {
        expect(keyboardEventShortcut(keyEvent({ key: 'π', code: 'KeyP', altKey: true }))).toBe(
            'alt+p',
        );
    });

    it('resolves an Option+digit chord from the physical key', () => {
        expect(keyboardEventShortcut(keyEvent({ key: '¡', code: 'Digit1', altKey: true }))).toBe(
            'alt+1',
        );
    });

    it('keeps Option chords distinguishable once Shift joins them', () => {
        expect(
            keyboardEventShortcut(
                keyEvent({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }),
            ),
        ).toBe('alt+shift+p');
    });

    /**
     * A non-letter Option chord has no `Key*`/`Digit*` code to fall back to, so it must keep using `event.key` rather
     * than silently dropping the main key.
     */
    it('falls back to the reported key for a non-alphanumeric Option chord', () => {
        expect(
            keyboardEventShortcut(keyEvent({ key: 'ArrowUp', code: 'ArrowUp', altKey: true })),
        ).toBe('alt+arrowup');
    });

    it('records the typed character for a non-Alt chord so remapped layouts still work', () => {
        expect(keyboardEventShortcut(keyEvent({ key: 'ż', code: 'KeyZ', metaKey: true }))).toBe(
            'cmd+ż',
        );
    });

    it('names the space bar instead of emitting a blank chord', () => {
        expect(keyboardEventShortcut(keyEvent({ key: ' ', code: 'Space', ctrlKey: true }))).toBe(
            'ctrl+space',
        );
    });

    it('sorts modifiers into the canonical order regardless of how they are held', () => {
        const chord = keyboardEventShortcut(
            keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }),
        );
        expect(chord).toBe(
            keyboardEventShortcut(
                keyEvent({ key: 'Tab', code: 'Tab', shiftKey: true, ctrlKey: true }),
            ),
        );
        expect(formatShortcut(chord)).toBe('⌃⇧⇥');
    });
});

describe('buildShortcutMap', () => {
    it('lets the first declaration of a chord win', () => {
        const map = buildShortcutMap([
            { key: 'cmd+k', command: 'first' },
            { key: 'Cmd+K', command: 'second' },
        ]);
        expect(resolveShortcutBinding(map, 'cmd+k', { terminalFocus: false })?.command).toBe(
            'first',
        );
        expect(map.size).toBe(1);
    });

    it('keys a two-chord binding by its whole normalized sequence', () => {
        const map = buildShortcutMap([
            { key: 'Cmd+K  Cmd+S', command: 'settings.openKeybindings' },
        ]);

        expect(resolveShortcutBinding(map, 'cmd+k cmd+s', { terminalFocus: false })?.command).toBe(
            'settings.openKeybindings',
        );
        expect(resolveShortcutBinding(map, 'cmd+k', { terminalFocus: false })).toBeUndefined();
    });

    it('matches a chord recorded from an Option keystroke', () => {
        const map = buildShortcutMap([{ key: 'alt+p', command: 'pathBrowser.open' }]);
        const chord = keyboardEventShortcut(keyEvent({ key: 'π', code: 'KeyP', altKey: true }));
        expect(resolveShortcutBinding(map, chord, { terminalFocus: false })?.command).toBe(
            'pathBrowser.open',
        );
    });

    it('resolves terminalFocus before forwarding the matching binding arguments', () => {
        const sequence = {
            args: { text: '\u{1B}[1;3B' },
            command: 'workbench.action.terminal.sendSequence',
            key: 'cmd+enter',
            when: 'terminalFocus' as const,
        };
        const map = buildShortcutMap([sequence, { command: 'editor.fallback', key: 'cmd+enter' }]);

        expect(resolveShortcutBinding(map, 'cmd+enter', { terminalFocus: true })).toEqual(sequence);
        expect(resolveShortcutBinding(map, 'cmd+enter', { terminalFocus: false })?.command).toBe(
            'editor.fallback',
        );
        expect(
            resolveShortcutBinding(buildShortcutMap([sequence]), 'cmd+enter', {
                terminalFocus: false,
            }),
        ).toBeUndefined();
    });
});

describe('resolveShortcutBinding availability', () => {
    it('skips a binding whose command cannot run for the next one on the same key', () => {
        const map = buildShortcutMap([
            { command: 'agentChat.allowRequest', key: 'cmd+enter' },
            { command: 'workbench.action.terminal.sendSequence', key: 'cmd+enter' },
        ]);
        const isCommandAvailable = (command: string) => command !== 'agentChat.allowRequest';

        expect(
            resolveShortcutBinding(map, 'cmd+enter', { isCommandAvailable, terminalFocus: false })
                ?.command,
        ).toBe('workbench.action.terminal.sendSequence');
        expect(resolveShortcutBinding(map, 'cmd+enter', { terminalFocus: false })?.command).toBe(
            'agentChat.allowRequest',
        );
    });
});

describe('isModifierKey', () => {
    it('identifies lone modifier presses, which never open or complete a chord', () => {
        for (const key of ['Alt', 'Control', 'Meta', 'Shift']) {
            expect(isModifierKey(key)).toBe(true);
        }
        expect(isModifierKey('Tab')).toBe(false);
        expect(isModifierKey('a')).toBe(false);
    });
});

describe('isKeybindingRecordingEventTarget', () => {
    it('recognizes only a target inside the active keybinding recorder without requiring a DOM', () => {
        const recordingTarget = {
            closest: (selector: string) =>
                selector === '[data-keybinding-recording="true"]' ? {} : null,
        } as unknown as EventTarget;
        const ordinaryTarget = { closest: () => null } as unknown as EventTarget;

        expect(isKeybindingRecordingEventTarget(recordingTarget)).toBe(true);
        expect(isKeybindingRecordingEventTarget(ordinaryTarget)).toBe(false);
        expect(isKeybindingRecordingEventTarget(null)).toBe(false);
    });
});

describe('ariaKeyShortcuts', () => {
    it('spells a stored binding the way aria-keyshortcuts names keys', () => {
        expect(ariaKeyShortcuts('cmd+enter')).toBe('Meta+Enter');
        expect(ariaKeyShortcuts('cmd+backspace')).toBe('Meta+Backspace');
        expect(ariaKeyShortcuts('ctrl+alt+shift+arrowleft')).toBe('Control+Alt+Shift+ArrowLeft');
        expect(ariaKeyShortcuts('alt+y')).toBe('Alt+Y');
        expect(ariaKeyShortcuts('f2')).toBe('F2');
    });

    it('gives a chord sequence or a missing binding no spelling', () => {
        expect(ariaKeyShortcuts('cmd+k cmd+s')).toBeUndefined();
        expect(ariaKeyShortcuts(undefined)).toBeUndefined();
    });
});

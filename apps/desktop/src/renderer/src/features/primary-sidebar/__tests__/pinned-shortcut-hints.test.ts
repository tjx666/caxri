import { describe, expect, it } from 'vitest';

import {
    heldModifierChord,
    pinnedShortcutCommand,
    pinnedShortcutHint,
} from '../pinned-shortcut-hints';

const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('heldModifierChord', () => {
    it('orders held modifiers the way keybindings normalize them', () => {
        expect(heldModifierChord({ ...none, metaKey: true })).toBe('cmd');
        expect(heldModifierChord({ ...none, shiftKey: true, metaKey: true })).toBe('cmd+shift');
        expect(heldModifierChord(none)).toBe('');
    });
});

describe('pinnedShortcutCommand', () => {
    it('numbers the first eight rows and gives the ninth chord to the last row only', () => {
        expect(pinnedShortcutCommand(0, 3)).toBe('session.openPinned1');
        expect(pinnedShortcutCommand(7, 12)).toBe('session.openPinned8');
        expect(pinnedShortcutCommand(8, 12)).toBeUndefined();
        expect(pinnedShortcutCommand(11, 12)).toBe('session.openPinned9');
        expect(pinnedShortcutCommand(8, 9)).toBe('session.openPinned9');
    });
});

describe('pinnedShortcutHint', () => {
    const keybindings = [
        { key: 'cmd+1', command: 'session.openPinned1' },
        { key: 'ctrl+2', command: 'session.openPinned2' },
        { key: 'cmd+k 3', command: 'session.openPinned3' },
    ];

    it('shows a binding whose modifiers are exactly the held ones', () => {
        expect(pinnedShortcutHint(keybindings, 'session.openPinned1', 'cmd')).toBe('cmd+1');
        expect(pinnedShortcutHint(keybindings, 'session.openPinned2', 'ctrl')).toBe('ctrl+2');
    });

    it('hides it for other modifiers, sequences, unbound commands, and no held modifier', () => {
        expect(pinnedShortcutHint(keybindings, 'session.openPinned1', 'cmd+shift')).toBeUndefined();
        expect(pinnedShortcutHint(keybindings, 'session.openPinned3', 'cmd')).toBeUndefined();
        expect(pinnedShortcutHint(keybindings, 'session.openPinned4', 'cmd')).toBeUndefined();
        expect(pinnedShortcutHint(keybindings, 'session.openPinned1', '')).toBeUndefined();
        expect(pinnedShortcutHint(keybindings, undefined, 'cmd')).toBeUndefined();
    });
});

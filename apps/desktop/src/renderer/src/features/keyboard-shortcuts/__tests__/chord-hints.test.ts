import type { Keybinding } from '@caxri/protocol';
import { defaultKeybindings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildChordHints } from '../chord-hints';
import type { KeyboardShortcutLabels } from '../keyboard-shortcut-groups';

const labels: KeyboardShortcutLabels = {
    category: (category) => category,
    pinnedRangeTitle: 'pinned',
    title: (command) => command.title,
};

describe('buildChordHints', () => {
    it('lists only the continuations of the armed chord, by their second keystroke', () => {
        const keybindings: Keybinding[] = [
            { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
            { key: 'cmd+k cmd+r', command: 'help.showKeyboardShortcuts' },
            { key: 'cmd+s', command: 'editor.save' },
            { key: 'cmd+j cmd+x', command: 'terminal.new' },
        ];
        const hints = buildChordHints(keybindings, 'cmd+k', [], labels);
        expect(
            hints
                .map(({ command, secondKey }) => [command, secondKey])
                .toSorted((left, right) => left[1].localeCompare(right[1])),
        ).toEqual([
            ['help.showKeyboardShortcuts', 'cmd+r'],
            ['settings.openKeybindings', 'cmd+s'],
        ]);
        expect(hints.find(({ command }) => command === 'settings.openKeybindings')?.title).toBe(
            'Edit Keyboard Shortcuts',
        );
    });

    it('reflects a rebound sequence and names contributed commands', () => {
        const hints = buildChordHints(
            [{ key: 'cmd+k cmd+9', command: 'ext.run' }],
            'cmd+k',
            [{ id: 'ext.run', title: 'Run Extension Thing' }],
            labels,
        );
        expect(hints).toEqual([
            { command: 'ext.run', secondKey: 'cmd+9', title: 'Run Extension Thing' },
        ]);
    });

    it('is empty when nothing continues the chord', () => {
        expect(buildChordHints(defaultKeybindings, 'cmd+q', [], labels)).toEqual([]);
    });

    it('finds the default Cmd+K family', () => {
        const hints = buildChordHints(defaultKeybindings, 'cmd+k', [], labels);
        expect(hints.some(({ secondKey }) => secondKey === 'cmd+s')).toBe(true);
    });
});

import { describe, expect, it } from 'vitest';

import type { Keybinding } from '@shared/types';

import { formatShortcut, formatShortcutParts } from '../../lib/keybindings';
import {
    appendKeybindingSource,
    buildKeybindingRows,
    cancelRecording,
    captureRecordingKey,
    commitOnBlur,
    commitOnEnter,
    filterKeybindingRows,
    isFocusNavigationKey,
    isModifierKey,
    removeKeybindingSource,
    startRecording,
    updateKeybindingSource,
} from './keybinding-editor';

const bindings: Keybinding[] = [
    { key: 'cmd+x', command: 'custom.doThing' },
    { key: 'cmd+t', command: 'terminal.new' },
    { key: 'cmd+shift+t', command: 'terminal.new' },
];

describe('shortcut formatting', () => {
    it('uses one stable macOS modifier order and keycap parts', () => {
        expect(formatShortcutParts('command+alt+shift+p')).toEqual(['⌥', '⇧', '⌘', 'P']);
        expect(formatShortcut('command+alt+shift+p')).toBe('⌥⇧⌘P');
    });
});

describe('keybinding rows', () => {
    const rows = buildKeybindingRows(bindings);

    it('keeps unknown commands and duplicate bindings while adding unbound catalog commands', () => {
        expect(rows.filter((row) => row.command === 'terminal.new')).toHaveLength(2);
        expect(rows).toContainEqual(
            expect.objectContaining({
                bindingIndex: 0,
                category: 'Custom',
                command: 'custom.doThing',
                title: 'custom.doThing',
            }),
        );
        const unbound = rows.find((row) => row.command === 'project.delete');
        expect(unbound).toMatchObject({ command: 'project.delete', title: 'Delete Project' });
        expect(unbound?.bindingIndex).toBeUndefined();
        expect(unbound?.key).toBeUndefined();
    });

    it('searches title, command ID, category, raw shortcut, and formatted shortcut', () => {
        expect(filterKeybindingRows(rows, 'new terminal')).toHaveLength(2);
        expect(filterKeybindingRows(rows, 'custom.dothing')).toHaveLength(1);
        expect(filterKeybindingRows(rows, 'project')).not.toHaveLength(0);
        expect(filterKeybindingRows(rows, 'cmd+shift+t')).toHaveLength(1);
        expect(filterKeybindingRows(rows, '⇧⌘T')).toHaveLength(1);
    });
});

describe('recording key classification', () => {
    it('treats Tab as a focus-navigation key that must never be captured', () => {
        expect(isFocusNavigationKey('Tab')).toBe(true);
        expect(isFocusNavigationKey('a')).toBe(false);
        expect(isFocusNavigationKey('Enter')).toBe(false);
    });

    it('identifies lone modifier presses that only arm further recording', () => {
        for (const key of ['Alt', 'Control', 'Meta', 'Shift']) {
            expect(isModifierKey(key)).toBe(true);
        }
        expect(isModifierKey('Tab')).toBe(false);
        expect(isModifierKey('a')).toBe(false);
    });
});

describe('keybinding JSONC edits', () => {
    const source = [
        '[',
        '  // Keep this custom shortcut note.',
        '  { "key": "cmd+x", "command": "custom.doThing" },',
        '  { "key": "cmd+t", "command": "terminal.new" }',
        ']',
        '',
    ].join('\n');

    it('updates and removes by binding index without rewriting unrelated comments or order', () => {
        const updated = updateKeybindingSource(source, 1, 'cmd+alt+t');
        expect(updated).toContain('// Keep this custom shortcut note.');
        expect(updated.indexOf('custom.doThing')).toBeLessThan(updated.indexOf('terminal.new'));
        expect(updated).toContain('"key": "cmd+alt+t"');

        const removed = removeKeybindingSource(updated, 1);
        expect(removed).toContain('// Keep this custom shortcut note.');
        expect(removed).toContain('custom.doThing');
        expect(removed).not.toContain('terminal.new');
    });

    it('appends a catalog binding without normalizing existing JSONC', () => {
        const appended = appendKeybindingSource(source, bindings.length - 1, {
            key: 'cmd+p',
            command: 'pathBrowser.open',
        });

        expect(appended).toContain('// Keep this custom shortcut note.');
        expect(appended).toContain('"command": "pathBrowser.open"');
        expect(appended.indexOf('custom.doThing')).toBeLessThan(
            appended.indexOf('pathBrowser.open'),
        );
    });
});

describe('shortcut recording transitions', () => {
    it('arms a row with no captured chord', () => {
        expect(startRecording('row-1')).toEqual({ rowId: 'row-1' });
    });

    it('overwrites the captured chord on a further key press instead of appending', () => {
        const armed = startRecording('row-1');
        const first = captureRecordingKey(armed, 'cmd+p');
        const second = captureRecordingKey(first, 'cmd+shift+p');

        expect(first).toEqual({ rowId: 'row-1', pending: 'cmd+p' });
        expect(second).toEqual({ rowId: 'row-1', pending: 'cmd+shift+p' });
    });

    it('Enter is a no-op while nothing has been captured, keeping recording open', () => {
        expect(commitOnEnter(startRecording('row-1'))).toBeUndefined();
    });

    it('Enter commits the captured chord and ends recording', () => {
        const captured = captureRecordingKey(startRecording('row-1'), 'cmd+k');

        expect(commitOnEnter(captured)).toEqual({ next: undefined, commit: 'cmd+k' });
    });

    it('Escape and a plain click-away always cancel without committing', () => {
        expect(cancelRecording()).toEqual({ next: undefined });
    });

    it('blur before any key is captured cancels instead of committing', () => {
        expect(commitOnBlur(startRecording('row-1'))).toEqual({ next: undefined });
    });

    it('blur after a chord is captured commits it — losing focus must never discard input', () => {
        const captured = captureRecordingKey(startRecording('row-1'), 'cmd+alt+t');

        expect(commitOnBlur(captured)).toEqual({ next: undefined, commit: 'cmd+alt+t' });
    });
});

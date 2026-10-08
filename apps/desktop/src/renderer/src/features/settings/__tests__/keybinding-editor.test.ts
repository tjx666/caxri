import type { Keybinding } from '@caxri/protocol';
import { formatShortcut, formatShortcutChords } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { KeybindingRow } from '../keybinding-editor';
import {
    appendKeybindingSource,
    buildKeybindingRows,
    cancelRecording,
    captureRecordingKey,
    clearRecordingKey,
    commitOnBlur,
    commitOnEnter,
    filterKeybindingRows,
    groupKeybindingRows,
    isFocusNavigationKey,
    removeKeybindingSource,
    startRecording,
    updateKeybindingSource,
} from '../keybinding-editor';

const bindings: Keybinding[] = [
    { key: 'cmd+x', command: 'custom.doThing' },
    { key: 'cmd+t', command: 'terminal.new' },
    { key: 'cmd+shift+t', command: 'terminal.new' },
];

describe('shortcut formatting', () => {
    it('uses one stable macOS modifier order and keycap parts', () => {
        expect(formatShortcutChords('command+alt+shift+p')).toEqual([['⌥', '⇧', '⌘', 'P']]);
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
        expect(filterKeybindingRows(rows, 'new terminal').map((row) => row.command)).toEqual([
            'terminal.new',
            'terminal.new',
            'terminal.newInSplit',
        ]);
        expect(filterKeybindingRows(rows, 'custom.dothing')).toHaveLength(1);
        expect(filterKeybindingRows(rows, 'project')).not.toHaveLength(0);
        expect(filterKeybindingRows(rows, 'cmd+shift+t')).toHaveLength(1);
        expect(filterKeybindingRows(rows, '⇧⌘T')).toHaveLength(1);
    });

    it('shows an existing argument-required binding without offering an incomplete unbound row', () => {
        expect(
            rows.find((row) => row.command === 'workbench.action.terminal.sendSequence'),
        ).toBeUndefined();

        const configured = buildKeybindingRows([
            ...bindings,
            {
                args: { text: '\u{1B}[1;3B' },
                command: 'workbench.action.terminal.sendSequence',
                key: 'cmd+enter',
                when: 'terminalFocus',
            },
        ]).find((row) => row.command === 'workbench.action.terminal.sendSequence');

        expect(configured).toMatchObject({
            category: 'Terminal',
            key: 'cmd+enter',
            title: 'Send Sequence',
        });
    });
});

describe('groupKeybindingRows', () => {
    function row(id: string, category: string): KeybindingRow {
        return { category, command: id, description: id, id, title: id };
    }

    it('gathers rows sharing a category even when they are scattered apart in the source list', () => {
        const rows = [row('view-1', 'View'), row('terminal-1', 'Terminal'), row('view-2', 'View')];

        expect(groupKeybindingRows(rows)).toEqual([
            { category: 'View', rows: [row('view-1', 'View'), row('view-2', 'View')] },
            { category: 'Terminal', rows: [row('terminal-1', 'Terminal')] },
        ]);
    });

    it('orders groups by each category’s first appearance, not alphabetically', () => {
        const rows = [row('b-1', 'B'), row('a-1', 'A')];

        expect(groupKeybindingRows(rows).map((group) => group.category)).toEqual(['B', 'A']);
    });

    it('drops a category entirely once search filtering leaves it with no rows', () => {
        const rows = [row('view-1', 'View'), row('terminal-1', 'Terminal')];
        const filtered = filterKeybindingRows(rows, 'terminal');

        expect(groupKeybindingRows(filtered)).toEqual([
            { category: 'Terminal', rows: [row('terminal-1', 'Terminal')] },
        ]);
    });
});

describe('recording key classification', () => {
    it('keeps bare Tab as focus navigation while allowing modified Tab shortcuts', () => {
        const event = (
            key: string,
            modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {},
        ) => ({
            altKey: false,
            ctrlKey: false,
            key,
            metaKey: false,
            ...modifiers,
        });
        expect(isFocusNavigationKey(event('Tab'))).toBe(true);
        expect(isFocusNavigationKey(event('Tab', { altKey: true, ctrlKey: true }))).toBe(false);
        expect(isFocusNavigationKey(event('a'))).toBe(false);
        expect(isFocusNavigationKey(event('Enter'))).toBe(false);
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

    it('extends the capture into a two-chord sequence on a further key press', () => {
        const armed = startRecording('row-1');
        const first = captureRecordingKey(armed, 'cmd+k');
        const second = captureRecordingKey(first, 'cmd+s');

        expect(first).toEqual({ rowId: 'row-1', pending: 'cmd+k' });
        expect(second).toEqual({ rowId: 'row-1', pending: 'cmd+k cmd+s' });
    });

    it('starts a fresh sequence once the two-chord ceiling is reached', () => {
        const full = captureRecordingKey(
            captureRecordingKey(startRecording('row-1'), 'cmd+k'),
            'cmd+s',
        );

        expect(captureRecordingKey(full, 'cmd+p')).toEqual({ rowId: 'row-1', pending: 'cmd+p' });
    });

    it('clearing discards the capture while staying armed on the same row', () => {
        const captured = captureRecordingKey(startRecording('row-1'), 'cmd+k');

        expect(clearRecordingKey(captured)).toEqual({ rowId: 'row-1' });
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

    it('blur after a chord is captured commits it: losing focus must never discard input', () => {
        const captured = captureRecordingKey(startRecording('row-1'), 'cmd+alt+t');

        expect(commitOnBlur(captured)).toEqual({ next: undefined, commit: 'cmd+alt+t' });
    });
});

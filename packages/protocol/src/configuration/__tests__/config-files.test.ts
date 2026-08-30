import { describe, expect, it } from 'vitest';

import type { DefaultKeybindingChange } from '../config-files';
import { reconcileDefaultKeybindings } from '../config-files';

const changes = [
    {
        type: 'replace',
        previous: { key: 'alt+p', command: 'pathBrowser.open' },
        current: { key: 'cmd+p', command: 'pathBrowser.open' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
    },
] satisfies readonly DefaultKeybindingChange[];

describe('reconcileDefaultKeybindings', () => {
    it('replaces one exact old default and appends one unoccupied new default', () => {
        expect(
            reconcileDefaultKeybindings(
                [
                    { key: 'alt+p', command: 'pathBrowser.open' },
                    { key: 'cmd+t', command: 'terminal.new' },
                ],
                changes,
            ),
        ).toEqual({
            additions: [{ key: 'cmd+3', command: 'secondarySidebar.showStatus' }],
            replacements: [{ index: 0, binding: { key: 'cmd+p', command: 'pathBrowser.open' } }],
            value: [
                { key: 'cmd+p', command: 'pathBrowser.open' },
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
            ],
        });
    });

    it('replaces a command rename when the destination chord belongs to that exact old default', () => {
        const previous = { key: 'cmd+shift+f', command: 'inspector.searchFiles' };
        const current = { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' };

        expect(
            reconcileDefaultKeybindings([previous], [{ type: 'replace', previous, current }]),
        ).toEqual({
            additions: [],
            replacements: [{ index: 0, binding: current }],
            value: [current],
        });
    });

    it('preserves custom bindings, occupied target chords, and ambiguous duplicate defaults', () => {
        const original = [
            { key: 'cmd+alt+p', command: 'pathBrowser.open' },
            { key: 'CMD+3', command: 'custom.command' },
            { key: 'alt+p', command: 'pathBrowser.open' },
            { key: 'alt+p', command: 'pathBrowser.open' },
        ];

        expect(reconcileDefaultKeybindings(original, changes)).toEqual({
            additions: [],
            replacements: [],
            value: original,
        });
    });

    it('does not mistake contextual or argument-bearing custom entries for an exact old default', () => {
        const original = [
            { key: 'alt+p', command: 'pathBrowser.open', when: 'terminalFocus' as const },
            { key: 'alt+p', command: 'pathBrowser.open', args: { source: 'custom' } },
        ];

        expect(reconcileDefaultKeybindings(original, changes).replacements).toEqual([]);
    });

    it('preserves command arguments when adding a new default', () => {
        const binding = {
            key: 'cmd+shift+enter',
            command: 'workbench.action.terminal.sendSequence',
            when: 'terminalFocus' as const,
            args: { text: '\t\n' },
        };

        expect(reconcileDefaultKeybindings([], [{ type: 'add', binding }])).toEqual({
            additions: [binding],
            replacements: [],
            value: [binding],
        });

        const custom = { ...binding, key: 'cmd+enter', args: { text: 'custom' } };
        expect(reconcileDefaultKeybindings([custom], [{ type: 'add', binding }])).toEqual({
            additions: [],
            replacements: [],
            value: [custom],
        });
    });
});

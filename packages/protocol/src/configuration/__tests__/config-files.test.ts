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
});

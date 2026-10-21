import { describe, expect, it } from 'vitest';

import type { DefaultKeybindingChange } from '../config-files';
import {
    buildChordLeadingChords,
    findKeybindingConflicts,
    reconcileDefaultKeybindings,
} from '../config-files';

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
            removals: [],
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
            removals: [],
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
            removals: [],
            replacements: [],
            value: original,
        });
    });

    it('removes only the exact old default and reports its input index', () => {
        const previous = { key: 'cmd+shift+w', command: 'session.closeTab' };
        const kept = { key: 'cmd+t', command: 'terminal.new' };
        const remove = [{ type: 'remove', previous }] satisfies readonly DefaultKeybindingChange[];

        expect(reconcileDefaultKeybindings([kept, previous], remove)).toEqual({
            additions: [],
            removals: [1],
            replacements: [],
            value: [kept],
        });
        const custom = { ...previous, key: 'cmd+alt+w' };
        expect(reconcileDefaultKeybindings([custom], remove).removals).toEqual([]);
        expect(
            reconcileDefaultKeybindings([{ ...previous, when: 'terminalFocus' as const }], remove)
                .removals,
        ).toEqual([]);
    });

    it('frees a removed default chord for a later addition in the same batch', () => {
        const previous = { key: 'cmd+shift+w', command: 'session.closeTab' };
        const binding = { key: 'cmd+shift+w', command: 'window.close' };

        expect(
            reconcileDefaultKeybindings(
                [previous],
                [
                    { type: 'remove', previous },
                    { type: 'add', binding },
                ],
            ),
        ).toEqual({ additions: [binding], removals: [0], replacements: [], value: [binding] });
    });

    /**
     * The caller writes additions after its in-place edits, so an edit aimed at an entry this batch added has no index
     * in the file to address. It reshapes the addition instead.
     */
    it('folds a replace or remove aimed at a same-batch addition into the additions', () => {
        const added = { key: 'cmd+2', command: 'session.openTab2' };
        const renamed = { key: 'cmd+2', command: 'session.openPinned2' };
        const withdrawn = { key: 'cmd+shift+w', command: 'session.closeTab' };

        expect(
            reconcileDefaultKeybindings(
                [],
                [
                    { type: 'add', binding: added },
                    { type: 'add', binding: withdrawn },
                    { type: 'replace', previous: added, current: renamed },
                    { type: 'remove', previous: withdrawn },
                ],
            ),
        ).toEqual({ additions: [renamed], removals: [], replacements: [], value: [renamed] });
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
            removals: [],
            replacements: [],
            value: [binding],
        });

        const custom = { ...binding, key: 'cmd+enter', args: { text: 'custom' } };
        expect(reconcileDefaultKeybindings([custom], [{ type: 'add', binding }])).toEqual({
            additions: [],
            removals: [],
            replacements: [],
            value: [custom],
        });
    });

    /**
     * `cmd+k` and `cmd+k cmd+s` are not independent chords: dispatch arms the pending chord, so the single-chord
     * binding would win and the sequence would never fire. Adding a sequence over an occupied opening chord must fail
     * closed exactly like adding a duplicate chord does.
     */
    it('refuses to add a sequence whose opening chord a single-chord binding already holds', () => {
        const held = { key: 'cmd+k', command: 'terminal.clear' };
        const sequence = { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' };

        expect(reconcileDefaultKeybindings([held], [{ type: 'add', binding: sequence }])).toEqual({
            additions: [],
            removals: [],
            replacements: [],
            value: [held],
        });
    });

    it('adds the sequence once the same batch has moved the opening chord away', () => {
        const previous = { key: 'cmd+k', command: 'terminal.clear' };
        const current = { key: 'cmd+shift+k', command: 'terminal.clear' };
        const sequence = { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' };

        expect(
            reconcileDefaultKeybindings(
                [previous],
                [
                    { type: 'replace', previous, current },
                    { type: 'add', binding: sequence },
                ],
            ).value,
        ).toEqual([current, sequence]);
    });
});

describe('findKeybindingConflicts', () => {
    it('reports one normalized keybinding claimed by several commands', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'Cmd+T', command: 'session.create' },
            ]),
        ).toEqual([
            { key: 'cmd+t', commands: ['terminal.new', 'session.create'], reason: 'duplicate' },
        ]);
    });

    it('stays silent when one command holds the same keybinding twice', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'cmd+t', command: 'terminal.new' },
            ]),
        ).toEqual([]);
    });

    /**
     * The collision that pushed Terminal Clear off `Cmd+K`: a binding standing on a sequence's opening chord can never
     * fire, and nothing in the old same-key check could see it. Only the dead binding is reported: the sequence keeps
     * working, so a warning on its row would be noise.
     */
    it('reports a binding standing on a sequence opening chord, not the sequence', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+k', command: 'terminal.clear' },
                { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
            ]),
        ).toEqual([{ key: 'cmd+k', commands: ['terminal.clear'], reason: 'chordPrefix' }]);
    });

    /**
     * `cmd+k` stays reserved for Monaco's chords whether or not a binding uses it, so the warning cannot depend on a
     * sequence being present: removing the shipped `cmd+k …` defaults and rebinding the bare chord is exactly how a
     * user upgrading from a build where `Cmd+K` was Terminal Clear would reach this state.
     */
    it('reports a binding on the reserved chord even with no sequence in the table', () => {
        expect(findKeybindingConflicts([{ key: 'cmd+k', command: 'terminal.clear' }])).toEqual([
            { key: 'cmd+k', commands: ['terminal.clear'], reason: 'chordPrefix' },
        ]);
    });

    it('leaves two sequences sharing an opening chord alone', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
                { key: 'cmd+k v', command: 'editor.openPreviewToSide' },
            ]),
        ).toEqual([]);
    });
});

describe('buildChordLeadingChords', () => {
    it('collects the opening chord of every two-chord binding', () => {
        const leading = buildChordLeadingChords([
            { key: 'Cmd+K Cmd+S', command: 'settings.openKeybindings' },
            { key: 'cmd+j x', command: 'custom.sequence' },
            { key: 'cmd+t', command: 'terminal.new' },
        ]);

        expect(leading.has('cmd+k')).toBe(true);
        expect(leading.has('cmd+j')).toBe(true);
        expect(leading.has('cmd+t')).toBe(false);
    });

    /**
     * Regression for the collision this whole mechanism exists to prevent: with `Cmd+K` derived only from the live
     * table, removing the last `cmd+k …` binding would let the continuation of `Cmd+K Cmd+1` resolve as a standalone
     * `Cmd+1` again and switch the Secondary Side Bar instead of folding.
     */
    it('reserves the editor chord prefix even when no binding uses it', () => {
        expect(
            buildChordLeadingChords([{ key: 'cmd+t', command: 'terminal.new' }]).has('cmd+k'),
        ).toBe(true);
    });
});

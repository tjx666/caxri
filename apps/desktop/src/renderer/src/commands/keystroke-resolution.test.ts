import type { Keybinding } from '@caxri/protocol';
import { buildChordLeadingChords, defaultKeybindings } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildShortcutMap } from '../lib/keybindings';
import type { KeystrokeOutcome, PendingChord } from './keystroke-resolution';
import { resolveKeydownBinding, resolveKeystroke } from './keystroke-resolution';

function shiftedBackquoteEvent(): KeyboardEvent {
    return {
        altKey: false,
        code: 'Backquote',
        ctrlKey: false,
        key: '~',
        metaKey: true,
        shiftKey: true,
    } as KeyboardEvent;
}

function keyEvent(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
        altKey: false,
        code: '',
        ctrlKey: false,
        key,
        metaKey: false,
        shiftKey: false,
        ...modifiers,
    } as KeyboardEvent;
}

describe('resolveKeydownBinding', () => {
    it('preserves an exact custom Cmd+Shift+Tilde binding ahead of Session MRU fallback', () => {
        const custom = { key: 'cmd+shift+~', command: 'terminal.new' } as const;
        const shortcutMap = buildShortcutMap([
            custom,
            { key: 'cmd+`', command: 'session.switchMru' },
        ]);

        expect(
            resolveKeydownBinding(shortcutMap, shiftedBackquoteEvent(), {
                terminalFocus: false,
            }),
        ).toEqual(custom);
    });

    it('uses the unshifted physical Backquote binding only for reverse Session MRU', () => {
        const sessionMru = { key: 'cmd+`', command: 'session.switchMru' } as const;
        const shortcutMap = buildShortcutMap([sessionMru]);

        expect(
            resolveKeydownBinding(shortcutMap, shiftedBackquoteEvent(), {
                terminalFocus: false,
            }),
        ).toEqual(sessionMru);
    });

    /**
     * Guards the whole shipped default set rather than one binding: macOS cycles the current app's windows with
     * `Cmd+Backquote` and `Cmd+Shift+Backquote`, and Caxri opens several windows, so no default may resolve either
     * stroke. Session MRU reverses on `Ctrl+Alt+Shift+Tab` through the unshifted fallback instead.
     */
    it('leaves Cmd+Backquote to the macOS window cycle across the shipped defaults', () => {
        const shortcutMap = buildShortcutMap(defaultKeybindings);

        expect(
            resolveKeydownBinding(
                shortcutMap,
                keyEvent('`', { code: 'Backquote', metaKey: true }),
                { terminalFocus: false },
            ),
        ).toBeUndefined();
        expect(
            resolveKeydownBinding(shortcutMap, shiftedBackquoteEvent(), { terminalFocus: false }),
        ).toBeUndefined();
        expect(
            resolveKeydownBinding(
                shortcutMap,
                keyEvent('Tab', { altKey: true, code: 'Tab', ctrlKey: true, shiftKey: true }),
                { terminalFocus: true },
            )?.command,
        ).toBe('session.switchMru');
    });

    /**
     * `Cmd+Shift+K` is Monaco's Delete Line. Terminal Clear opts into `allowInEditable`, so an ungated default would be
     * dispatched straight out of a focused editor and the line would never be deleted; the gate is the only thing
     * keeping the two commands on one chord.
     */
    it('leaves Cmd+Shift+K to the editor unless a Terminal owns focus', () => {
        const shortcutMap = buildShortcutMap(defaultKeybindings);
        const event = keyEvent('k', { metaKey: true, shiftKey: true });

        expect(resolveKeydownBinding(shortcutMap, event, { terminalFocus: false })).toBeUndefined();
        expect(resolveKeydownBinding(shortcutMap, event, { terminalFocus: true })?.command).toBe(
            'terminal.clear',
        );
    });
});

describe('resolveKeystroke', () => {
    const keybindings: Keybinding[] = [
        { key: 'cmd+1', command: 'secondarySidebar.showFiles' },
        { key: 'cmd+shift+k', command: 'terminal.clear' },
        { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
    ];
    const shortcutMap = buildShortcutMap(keybindings);
    const leadingChords = buildChordLeadingChords(keybindings);

    function step(
        event: KeyboardEvent,
        {
            editorFocus = false,
            pending,
            terminalFocus = false,
        }: { editorFocus?: boolean; pending?: PendingChord; terminalFocus?: boolean } = {},
    ): KeystrokeOutcome {
        return resolveKeystroke({
            editorFocus,
            event,
            leadingChords,
            pending,
            shortcutMap,
            terminalFocus,
        });
    }

    const commandK = keyEvent('k', { metaKey: true });

    it('arms the pending chord and consumes it outside the editor', () => {
        expect(step(commandK)).toEqual({
            kind: 'armChord',
            leadingChord: 'cmd+k',
            yieldToEditor: false,
        });
    });

    it('releases the leading chord to Monaco when the editor owns focus', () => {
        expect(step(commandK, { editorFocus: true })).toEqual({
            kind: 'armChord',
            leadingChord: 'cmd+k',
            yieldToEditor: true,
        });
    });

    /**
     * The collision this mechanism exists to remove: `Cmd+K Cmd+1` folds to level one instead of switching the
     * Secondary Side Bar, even though `cmd+1` is a live app binding.
     */
    it('leaves the continuation of an editor-owned sequence untouched', () => {
        expect(
            step(keyEvent('1', { metaKey: true }), {
                editorFocus: true,
                pending: { leadingChord: 'cmd+k', yieldToEditor: true },
            }),
        ).toEqual({ kind: 'yieldChordContinuation' });
    });

    it('resolves a Caxri-owned sequence from the pending chord and the current one', () => {
        expect(
            step(keyEvent('s', { metaKey: true }), {
                pending: { leadingChord: 'cmd+k', yieldToEditor: false },
            }),
        ).toEqual({
            kind: 'dispatch',
            binding: { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
        });
    });

    /**
     * A half-typed sequence must not leak its second key into a Terminal or an input, so an unmatched continuation is
     * swallowed rather than dispatched as a standalone shortcut.
     */
    it('cancels and swallows a Caxri-owned sequence that matches nothing', () => {
        expect(
            step(keyEvent('1', { metaKey: true }), {
                pending: { leadingChord: 'cmd+k', yieldToEditor: false },
            }),
        ).toEqual({ kind: 'cancelChord' });
    });

    it('swallows a continuation whose command cannot run, like one that matches nothing', () => {
        expect(
            resolveKeystroke({
                editorFocus: false,
                event: keyEvent('s', { metaKey: true }),
                isCommandAvailable: (command) => command !== 'settings.openKeybindings',
                leadingChords,
                pending: { leadingChord: 'cmd+k', yieldToEditor: false },
                shortcutMap,
                terminalFocus: false,
            }),
        ).toEqual({ kind: 'cancelChord' });
    });

    /**
     * A pending chord has no visible affordance, so an accidental `Cmd+K` over a dialog must not also eat the Escape
     * the user presses to close it. Escape ends the sequence and still reaches the dialog's own handler.
     */
    it('releases Escape instead of swallowing it as a failed continuation', () => {
        expect(
            step(keyEvent('Escape'), { pending: { leadingChord: 'cmd+k', yieldToEditor: false } }),
        ).toEqual({ kind: 'ignore' });
    });

    it('still resolves the standalone binding whose chord a sequence reuses as a continuation', () => {
        expect(step(keyEvent('1', { metaKey: true }))).toEqual({
            kind: 'dispatch',
            binding: { key: 'cmd+1', command: 'secondarySidebar.showFiles' },
        });
    });

    it('ignores a keystroke no binding claims', () => {
        expect(step(keyEvent('q', { metaKey: true }))).toEqual({ kind: 'ignore' });
    });
});

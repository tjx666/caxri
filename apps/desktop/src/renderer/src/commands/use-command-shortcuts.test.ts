import { describe, expect, it } from 'vitest';

import { buildShortcutMap } from '../lib/keybindings';
import { isEditorChordContinuationCommand, resolveKeydownBinding } from './use-command-shortcuts';

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
});

describe('isEditorChordContinuationCommand', () => {
    it('defers the commands whose stroke Monaco reads as a Cmd+K continuation', () => {
        // `Cmd+K Cmd+J` unfolds all and `Cmd+K Cmd+0` folds all. Claiming the second stroke in capture phase leaves
        // both chords dead inside the editor, which is how Focus Primary Side Bar broke Fold All when it took Cmd+0.
        expect(isEditorChordContinuationCommand('panel.toggle')).toBe(true);
        expect(isEditorChordContinuationCommand('primarySidebar.focus')).toBe(true);
    });

    it('keeps an ordinary app override in capture phase', () => {
        expect(isEditorChordContinuationCommand('terminal.new')).toBe(false);
        expect(isEditorChordContinuationCommand('session.rename')).toBe(false);
    });
});

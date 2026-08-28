import { describe, expect, it } from 'vitest';

import { buildShortcutMap } from '../lib/keybindings';
import { resolveKeydownBinding } from './use-command-shortcuts';

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

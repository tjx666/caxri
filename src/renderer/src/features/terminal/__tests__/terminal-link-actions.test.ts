import { describe, expect, it, vi } from 'vitest';

import {
    getTerminalDetectedLinks,
    openTerminalLinkPicker,
    registerTerminalLinkPickerHandler,
    registerTerminalLinkProvider,
} from '../terminal-link-actions';
import type { TerminalDetectedLink } from '../terminal-links';

function detectedLink(id: string): TerminalDetectedLink {
    return {
        accessibleName: `Open file link ${id}`,
        activate: vi.fn(),
        bufferLine: 0,
        id,
        kind: 'file',
        target: id,
    };
}

describe('Terminal link actions', () => {
    it('reads links only from the currently mounted provider', () => {
        const first = detectedLink('first.ts');
        const second = detectedLink('second.ts');
        const unregisterFirst = registerTerminalLinkProvider('terminal-1', () => [first]);
        const unregisterSecond = registerTerminalLinkProvider('terminal-1', () => [second]);

        unregisterFirst();
        expect(getTerminalDetectedLinks('terminal-1')).toEqual([second]);

        unregisterSecond();
        expect(getTerminalDetectedLinks('terminal-1')).toEqual([]);
    });

    it('does not let stale cleanup remove the active picker handler', () => {
        const first = vi.fn();
        const second = vi.fn();
        const unregisterFirst = registerTerminalLinkPickerHandler('terminal-1', first);
        const unregisterSecond = registerTerminalLinkPickerHandler('terminal-1', second);

        unregisterFirst();
        openTerminalLinkPicker('terminal-1');
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();

        unregisterSecond();
        openTerminalLinkPicker('terminal-1');
        expect(second).toHaveBeenCalledOnce();
    });
});

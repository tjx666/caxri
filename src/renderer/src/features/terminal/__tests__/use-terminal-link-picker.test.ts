import { describe, expect, it, vi } from 'vitest';

import type { TerminalDetectedLink } from '../terminal-links';
import { terminalLinkPickerReducer } from '../use-terminal-link-picker';

describe('terminalLinkPickerReducer', () => {
    it('drops detected targets when the picker closes', () => {
        const sensitiveLink: TerminalDetectedLink = {
            accessibleName: 'Open external link https://example.com/?token=secret',
            activate: vi.fn(),
            bufferLine: 0,
            id: 'osc:secret',
            kind: 'url',
            target: 'https://example.com/?token=secret',
        };
        const open = terminalLinkPickerReducer(
            { isOpen: false, links: [] },
            { type: 'open', links: [sensitiveLink] },
        );

        expect(terminalLinkPickerReducer(open, { type: 'close' })).toEqual({
            isOpen: false,
            links: [],
        });
    });
});

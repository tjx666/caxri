import { describe, expect, it, vi } from 'vitest';

import type { TerminalDetectedLink } from '../terminal-links';
import type { TerminalLinkPickerState } from '../use-terminal-link-picker';
import { terminalLinkPickerReducer } from '../use-terminal-link-picker';

const initialState: TerminalLinkPickerState = {
    isOpen: false,
    isTruncated: false,
    links: [],
    mode: 'detected',
    status: 'complete',
};

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
        const open = terminalLinkPickerReducer(initialState, { type: 'open' });
        const scanned = terminalLinkPickerReducer(open, {
            type: 'update',
            links: [sensitiveLink],
            status: 'complete',
        });

        expect(terminalLinkPickerReducer(scanned, { type: 'close' })).toEqual({
            isOpen: false,
            isTruncated: false,
            links: [],
            mode: 'detected',
            status: 'complete',
        });
    });

    it('opens with an empty, scanning state before the first chunk arrives', () => {
        expect(terminalLinkPickerReducer(initialState, { type: 'open' })).toEqual({
            isOpen: true,
            isTruncated: false,
            links: [],
            mode: 'detected',
            status: 'scanning',
        });
    });

    it('opens ambiguous file candidates without retaining a detected-link scan', () => {
        const candidate: TerminalDetectedLink = {
            accessibleName: 'Open matching file src/file.ts in Project',
            activate: vi.fn(),
            bufferLine: 0,
            detail: 'Project',
            id: 'candidate:project:file',
            kind: 'file',
            target: 'src/file.ts',
        };

        expect(
            terminalLinkPickerReducer(initialState, {
                type: 'openCandidates',
                links: [candidate],
                isTruncated: true,
            }),
        ).toEqual({
            isOpen: true,
            isTruncated: true,
            links: [candidate],
            mode: 'candidates',
            status: 'complete',
        });
    });

    it('ignores a stale scan update once the picker has closed', () => {
        expect(
            terminalLinkPickerReducer(initialState, {
                type: 'update',
                links: [],
                status: 'complete',
            }),
        ).toBe(initialState);
    });
});

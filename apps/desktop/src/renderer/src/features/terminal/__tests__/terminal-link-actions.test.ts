import { describe, expect, it, vi } from 'vitest';

import {
    createTerminalLinkScanner,
    openTerminalFileCandidatePicker,
    openTerminalLinkPicker,
    registerTerminalLinkPickerHandler,
    registerTerminalLinkScanner,
} from '../terminal-link-actions';
import type { TerminalLinkScanner } from '../terminal-link-scanner';
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

function scannerFor(links: TerminalDetectedLink[]): TerminalLinkScanner {
    return { scanNextChunk: () => ({ links, status: 'complete' }) };
}

describe('Terminal link actions', () => {
    it('reads a scanner only from the currently mounted factory', () => {
        const first = detectedLink('first.ts');
        const second = detectedLink('second.ts');
        const unregisterFirst = registerTerminalLinkScanner('terminal-1', () =>
            scannerFor([first]),
        );
        const unregisterSecond = registerTerminalLinkScanner('terminal-1', () =>
            scannerFor([second]),
        );

        unregisterFirst();
        expect(createTerminalLinkScanner('terminal-1')?.scanNextChunk()).toEqual({
            links: [second],
            status: 'complete',
        });

        unregisterSecond();
        expect(createTerminalLinkScanner('terminal-1')).toBeUndefined();
    });

    it('does not let stale cleanup remove the active picker handler', () => {
        const first = { openCandidates: vi.fn(), openDetected: vi.fn() };
        const second = { openCandidates: vi.fn(), openDetected: vi.fn() };
        const unregisterFirst = registerTerminalLinkPickerHandler('terminal-1', first);
        const unregisterSecond = registerTerminalLinkPickerHandler('terminal-1', second);

        unregisterFirst();
        openTerminalLinkPicker('terminal-1');
        expect(first.openDetected).not.toHaveBeenCalled();
        expect(second.openDetected).toHaveBeenCalledOnce();

        const candidate = detectedLink('candidate.ts');
        openTerminalFileCandidatePicker('terminal-1', [candidate], true);
        expect(second.openCandidates).toHaveBeenCalledWith([candidate], true);

        unregisterSecond();
        openTerminalLinkPicker('terminal-1');
        expect(second.openDetected).toHaveBeenCalledOnce();
    });
});

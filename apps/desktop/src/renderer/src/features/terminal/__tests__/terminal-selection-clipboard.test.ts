import { describe, expect, it, vi } from 'vitest';

import { TerminalSelectionClipboard } from '../terminal-selection-clipboard';

describe('TerminalSelectionClipboard', () => {
    it('serializes writes and coalesces pending changes to the latest selection', async () => {
        const firstWrite = Promise.withResolvers<void>();
        const latestWrite = Promise.withResolvers<void>();
        const writes: string[] = [];
        let clipboard = '';
        const writeText = vi.fn(async (value: string) => {
            writes.push(value);
            const pending = writes.length === 1 ? firstWrite.promise : latestWrite.promise;
            await pending;
            clipboard = value;
        });
        const selectionClipboard = new TerminalSelectionClipboard(() => {}, writeText);

        const settled = selectionClipboard.copy('first');
        // Both intermediate copies are intentionally left unawaited: the test asserts that only the
        // latest selection ('latest') is the one actually written once the writes settle.
        void selectionClipboard.copy('stale intermediate');
        void selectionClipboard.copy('latest');
        expect(writes).toEqual(['first']);
        firstWrite.resolve();
        await vi.waitFor(() => expect(writes).toEqual(['first', 'latest']));
        latestWrite.resolve();
        await settled;

        expect(clipboard).toBe('latest');
    });

    it('does not write an empty selection', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        const selectionClipboard = new TerminalSelectionClipboard(() => {}, writeText);

        await selectionClipboard.copy('');

        expect(writeText).not.toHaveBeenCalled();
    });
});

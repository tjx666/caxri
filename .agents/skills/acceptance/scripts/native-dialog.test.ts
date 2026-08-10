import { describe, expect, it } from 'vitest';

import { collectProcessTree, parseDialogOptions } from './native-dialog';

describe('Acceptance native dialog helper', () => {
    it('finds only the owned Electron process tree', () => {
        expect(
            collectProcessTree(10, [
                { pid: 11, ppid: 10 },
                { pid: 12, ppid: 11 },
                { pid: 20, ppid: 1 },
            ]),
        ).toEqual([10, 11, 12]);
    });

    it('parses a semantic dialog action', () => {
        expect(
            parseDialogOptions(['click', '--button', 'Move to Trash', '--timeout-ms', '5000']),
        ).toEqual({ button: 'Move to Trash', command: 'click', timeoutMs: 5000 });
    });

    it('rejects coordinate-like or incomplete actions by requiring a button name', () => {
        expect(() => parseDialogOptions(['click', '--timeout-ms', '5000'])).toThrow(
            '--button is required',
        );
    });

    it('bounds Accessibility waits', () => {
        expect(() =>
            parseDialogOptions(['inspect', '--button', 'Cancel', '--timeout-ms', '120001']),
        ).toThrow('--timeout-ms must be an integer between 1 and 120000');
    });
});

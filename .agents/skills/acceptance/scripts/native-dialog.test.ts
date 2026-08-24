import { describe, expect, it } from 'vitest';

import { ownedDialogProcessIds, parseDialogOptions } from './native-dialog';

describe('Acceptance native dialog helper', () => {
    it('queries only the uniquely identified main Electron process', () => {
        expect(ownedDialogProcessIds({ electronPid: 10 })).toEqual([10]);
    });

    it('parses a semantic dialog action', () => {
        expect(
            parseDialogOptions(['click', '--button', 'Move to Trash', '--timeout-ms', '5000']),
        ).toEqual({ button: 'Move to Trash', command: 'click', timeoutMs: 5000 });
    });

    it('supports a no-action preflight before the native trigger', () => {
        expect(parseDialogOptions(['preflight', '--timeout-ms', '3000'])).toEqual({
            button: undefined,
            command: 'preflight',
            timeoutMs: 3000,
        });
        expect(() => parseDialogOptions(['preflight', '--button', 'Open'])).toThrow(
            '--button is not valid for preflight',
        );
    });

    it('rejects coordinate-like or incomplete actions by requiring a button name', () => {
        expect(() => parseDialogOptions(['click', '--timeout-ms', '5000'])).toThrow(
            '--button is required',
        );
    });

    it('rejects duplicate options instead of silently changing the target', () => {
        expect(() =>
            parseDialogOptions(['click', '--button', 'Delete', '--button', 'Cancel']),
        ).toThrow('Duplicate option: --button');
    });

    it('bounds Accessibility waits', () => {
        expect(() =>
            parseDialogOptions(['inspect', '--button', 'Cancel', '--timeout-ms', '120001']),
        ).toThrow('--timeout-ms must be an integer between 1 and 120000');
    });
});

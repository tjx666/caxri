import { describe, expect, it } from 'vitest';

import {
    NATIVE_DIALOG_MAX_DEPTH,
    NATIVE_DIALOG_MAX_ELEMENTS,
    NATIVE_DIALOG_SCRIPT,
    ownedDialogProcessIds,
    parseDialogOptions,
    parseNativeDialogResult,
} from './native-dialog';

describe('Acceptance native dialog helper', () => {
    it('queries only the uniquely identified main Electron process', () => {
        expect(ownedDialogProcessIds({ electronPid: 10 })).toEqual([10]);
    });

    it('uses bounded semantic dialog attributes without expanding the full Accessibility tree', () => {
        const script = NATIVE_DIALOG_SCRIPT.join('\n');

        expect(script).toContain('AXDefaultButton');
        expect(script).toContain('AXCancelButton');
        expect(script).toContain('UI elements of');
        expect(script).toContain(`${NATIVE_DIALOG_MAX_DEPTH}, ${NATIVE_DIALOG_MAX_ELEMENTS}`);
        expect(script).toContain('"AXOutline", "AXScrollArea", "AXTable"');
        expect(script).not.toContain('entire contents');
        expect(script.match(/set frontmost/g)).toHaveLength(1);
    });

    it('fails closed when bounded Accessibility traversal cannot prove uniqueness', () => {
        expect(() => parseNativeDialogResult('limit\t\n')).toThrow(
            `${NATIVE_DIALOG_MAX_ELEMENTS}-element safety bound`,
        );
    });

    it('parses one exact owned-process match', () => {
        expect(parseNativeDialogResult('1\t42\n')).toEqual({ count: 1, pid: 42 });
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

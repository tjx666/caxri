import { describe, expect, it } from 'vitest';

import { consoleErrorLogFields } from '../console-error-fields';

const MARKER = 'caxri-secret-marker-9f2a';

describe('consoleErrorLogFields', () => {
    /**
     * The contract this file exists to hold. `desktop.jsonl` is copied verbatim into the diagnostics export, returned
     * by `logs.query`, and collected as an E2E artifact, and this is the only log field no call site controls; it
     * forwards whatever any Renderer code printed at error level. If the console text ever comes back, this fails.
     */
    it('never carries the console text in any field', () => {
        const fields = consoleErrorLogFields({
            message: `TypeError: ${MARKER} is not a function\n    at open (/Users/someone/project/src/a.ts:3:9)`,
            sourceId: 'file:///app.asar/renderer/index.js',
            lineNumber: 42,
        });

        for (const value of Object.values(fields)) expect(String(value)).not.toContain(MARKER);
        expect(JSON.stringify(fields)).not.toContain(MARKER);
    });

    it('keeps a blank-window crash triageable from the record alone', () => {
        expect(
            consoleErrorLogFields({
                message:
                    'TypeError: cannot read properties of undefined\n    in Workbench\n    in App',
                sourceId: 'http://localhost:5173/src/main.tsx',
                lineNumber: 42,
            }),
        ).toEqual({
            code: 'CONSOLE_ERROR',
            errorName: 'TypeError',
            messageId: expect.stringMatching(/^[0-9a-f]{12}$/) as string,
            messageLength: 74,
            source: 'http://localhost:5173/src/main.tsx:42',
            stackLines: 2,
        });
    });

    it('gives one fault one identity across repeats, and different faults different ones', () => {
        const message = 'RangeError: invalid array length';
        const first = consoleErrorLogFields({ message, sourceId: 'a.js', lineNumber: 1 });
        const repeat = consoleErrorLogFields({ message, sourceId: 'a.js', lineNumber: 1 });
        const other = consoleErrorLogFields({ message: 'RangeError: something else' });

        expect(repeat.messageId).toBe(first.messageId);
        expect(other.messageId).not.toBe(first.messageId);
    });

    it.each([
        { expected: 'TypeError', message: 'Uncaught TypeError: x is not a function' },
        { expected: 'DOMException', message: 'DOMException: The operation was aborted.' },
        // The two members with no prefix in front of `Error`, and the most common Renderer fault of all.
        { expected: 'Error', message: 'Uncaught Error: boom' },
        { expected: 'Error', message: 'Error: boom' },
        { expected: 'ErrorEvent', message: 'ErrorEvent: Script error.' },
        { expected: 'Unknown', message: 'Warning: something a library printed' },
        // A name read out of untrusted text is only logged when it matches the closed set.
        { expected: 'Unknown', message: 'CustomlyNamedError: leaked detail here' },
    ])('classifies $expected without trusting the text', ({ expected, message }) => {
        expect(consoleErrorLogFields({ message }).errorName).toBe(expected);
    });

    it('reports size and shape for an oversized message without carrying it', () => {
        const fields = consoleErrorLogFields({ message: 'x'.repeat(10_000) });

        expect(fields.messageLength).toBe(10_000);
        expect(fields.stackLines).toBe(0);
        expect(JSON.stringify(fields).length).toBeLessThan(300);
    });

    it('falls back when the source location is missing', () => {
        expect(consoleErrorLogFields({ message: 'boom' }).source).toBe('<unknown>:0');
    });
});

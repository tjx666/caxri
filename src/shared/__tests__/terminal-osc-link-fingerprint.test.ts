import { describe, expect, it } from 'vitest';

import {
    resolveTerminalOscLinkLogicalPosition,
    terminalOscLinkFingerprint,
    terminalOscLinkLogicalPosition,
} from '../terminal-osc-link-fingerprint';

function createBuffer(lines: Array<{ isWrapped: boolean; text: string }>) {
    return {
        get length() {
            return lines.length;
        },
        getLine(line: number) {
            const value = lines.at(line);
            if (!value) return;
            return {
                getCell(column: number) {
                    const chars = value.text.at(column) ?? '';
                    return { getChars: () => chars, getWidth: () => 1 };
                },
                isWrapped: value.isWrapped,
                length: value.text.length,
                translateToString: (
                    shouldTrimRight = false,
                    startColumn = 0,
                    endColumn = value.text.length,
                ) => {
                    const text = value.text.slice(startColumn, endColumn);
                    return shouldTrimRight ? text.trimEnd() : text;
                },
            };
        },
    };
}

describe('Terminal OSC link logical positions', () => {
    it('resolves the same label after its logical line reflows', () => {
        const source = createBuffer([
            { isWrapped: false, text: 'PREFIXLABEL' },
            { isWrapped: false, text: '' },
            { isWrapped: false, text: '' },
        ]);
        const reflowed = createBuffer([
            { isWrapped: false, text: 'PREFIX' },
            { isWrapped: true, text: 'LABEL' },
            { isWrapped: false, text: '' },
        ]);
        const sourceStart = { column: 6, line: 0 };
        const sourceEnd = { column: 11, line: 0 };
        const start = terminalOscLinkLogicalPosition(source, 12, sourceStart);
        const end = terminalOscLinkLogicalPosition(source, 12, sourceEnd);

        expect(start).toEqual({
            cellOffset: 6,
            logicalLineIndex: 0,
            logicalLineOffset: -3,
        });
        expect(end).toEqual({
            cellOffset: 11,
            logicalLineIndex: 0,
            logicalLineOffset: -3,
        });
        const reflowedStart = resolveTerminalOscLinkLogicalPosition(reflowed, 6, start!, 'start');
        const reflowedEnd = resolveTerminalOscLinkLogicalPosition(reflowed, 6, end!, 'start');
        expect(reflowedStart).toEqual({ column: 0, line: 1 });
        expect(reflowedEnd).toEqual({ column: 5, line: 1 });
        expect(resolveTerminalOscLinkLogicalPosition(reflowed, 6, start!, 'end')).toBeUndefined();
        expect(terminalOscLinkFingerprint(12, source, sourceStart, sourceEnd)).toBe(
            terminalOscLinkFingerprint(6, reflowed, reflowedStart!, reflowedEnd!),
        );
    });

    it('fingerprints hard line breaks without width-dependent blank padding', () => {
        const source = createBuffer([
            { isWrapped: false, text: 'PREFIXLABEL' },
            { isWrapped: false, text: 'NEXT' },
        ]);
        const reflowed = createBuffer([
            { isWrapped: false, text: 'PREFIX' },
            { isWrapped: true, text: 'LABEL' },
            { isWrapped: false, text: 'NEXT' },
        ]);
        const sourceStart = { column: 6, line: 0 };
        const sourceEnd = { column: 4, line: 1 };
        const start = terminalOscLinkLogicalPosition(source, 12, sourceStart)!;
        const end = terminalOscLinkLogicalPosition(source, 12, sourceEnd)!;
        const reflowedStart = resolveTerminalOscLinkLogicalPosition(reflowed, 6, start, 'start')!;
        const reflowedEnd = resolveTerminalOscLinkLogicalPosition(reflowed, 6, end, 'start')!;

        expect(terminalOscLinkFingerprint(12, source, sourceStart, sourceEnd)).toBe(
            terminalOscLinkFingerprint(6, reflowed, reflowedStart, reflowedEnd),
        );
    });

    it('accepts an exact 16-row label ending at the next wrapped row boundary', () => {
        const buffer = createBuffer([
            ...Array.from({ length: 16 }, (_, index) => ({
                isWrapped: index > 0,
                text: 'x'.repeat(100),
            })),
            { isWrapped: true, text: 'suffix' },
        ]);

        expect(
            terminalOscLinkFingerprint(
                100,
                buffer,
                { column: 0, line: 0 },
                { column: 0, line: 16 },
            ),
        ).toBeDefined();
    });
});

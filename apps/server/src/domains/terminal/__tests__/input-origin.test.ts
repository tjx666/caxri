import { describe, expect, it } from 'vitest';

import { isTerminalMouseReport, isTerminalProtocolResponse } from '../input-origin';

describe('Terminal input origin', () => {
    it.each([
        '\u{1B}[?1;2c',
        '\u{1B}[>0;276;0c',
        '\u{1B}[20;3R',
        '\u{1B}[?20;3R',
        '\u{1B}[0n',
        '\u{1B}[I',
        '\u{1B}[O',
        '\u{1B}[8;40;120t',
        '\u{1B}[?2004;1$y',
        '\u{1B}[?0u',
        '\u{1B}[?997;1n',
        '\u{1B}]10;rgb:ffff/0000/0000\u{1B}\\',
        '\u{1B}]4;2;rgb:ff/00/00\u{7}',
        '\u{1B}P>|xterm.js(6.1.0)\u{1B}\\',
        '\u{1B}[?1;2c\u{1B}[20;3R',
        '',
    ])('recognizes a complete automatic response %j', (data) => {
        expect(isTerminalProtocolResponse(data)).toBe(true);
    });

    it.each([
        'hello',
        '\r',
        '\u{1B}',
        '\u{3}',
        '\u{1B}[A',
        '\u{1B}[200~hello\u{1B}[201~',
        '\u{1B}[?1;2chello',
        '\u{1B}[?1;',
        '\u{1B}]0;user title\u{7}',
    ])('preserves human, unknown and mixed input %j', (data) => {
        expect(isTerminalProtocolResponse(data)).toBe(false);
    });

    it.each(['\u{1B}[<64;40;12M', '\u{1B}[<0;10;5M\u{1B}[<0;10;5m', '\u{1B}[<35;120;48M'])(
        'recognizes an SGR mouse report %j',
        (data) => {
            expect(isTerminalMouseReport(data)).toBe(true);
        },
    );

    it.each(['\u{1B}[<64;40;12', '\u{1B}[<64;40;12Mhello', '\u{1B}[64;40;12M', 'q'])(
        'keeps typed or partial input out of mouse reports %j',
        (data) => {
            expect(isTerminalMouseReport(data)).toBe(false);
        },
    );
});

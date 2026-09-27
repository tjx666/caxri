import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';

import { TerminalMouseWheelEncoder } from '../mouse-wheel';

const terminals: Terminal[] = [];

const setup = async (output: string) => {
    const terminal = new Terminal({ allowProposedApi: true, cols: 120, rows: 40, logLevel: 'off' });
    terminals.push(terminal);
    const encoder = new TerminalMouseWheelEncoder(terminal);
    await new Promise<void>((resolve) => terminal.write(output, resolve));
    return encoder;
};

afterEach(() => {
    for (const terminal of terminals) terminal.dispose();
    terminals.length = 0;
});

describe('Terminal mouse wheel encoding', () => {
    it('reports SGR wheel steps at the requested cell for a mouse-tracking application', async () => {
        const encoder = await setup('\u{1B}[?1049h\u{1B}[?1000h\u{1B}[?1006h');
        expect(encoder.encode({ col: 7, lines: -2, row: 3 })).toBe(
            '\u{1B}[<64;7;3M\u{1B}[<64;7;3M',
        );
        expect(encoder.encode({ col: 500, lines: 1, row: 90 })).toBe('\u{1B}[<65;120;40M');
    });

    it('uses the default encoding once SGR is reset', async () => {
        const encoder = await setup('\u{1B}[?1002;1006h\u{1B}[?1006l');
        expect(encoder.encode({ col: 1, lines: -1, row: 1 })).toBe('\u{1B}[M`!!');
    });

    it('refuses encodings it does not produce instead of sending the wrong format', async () => {
        const encoder = await setup('\u{1B}[?1000h\u{1B}[?1015h');
        expect(encoder.encode({ col: 1, lines: -1, row: 1 })).toBeNull();
    });

    it('sends cursor keys on an alternate screen without mouse tracking', async () => {
        const encoder = await setup('\u{1B}[?1049h\u{1B}[?1h');
        expect(encoder.encode({ col: 1, lines: 2, row: 1 })).toBe('\u{1B}OB\u{1B}OB');
    });

    it('leaves a normal-screen shell to local scrollback', async () => {
        const encoder = await setup('prompt $ ');
        expect(encoder.encode({ col: 1, lines: -1, row: 1 })).toBeNull();
    });

    it('forgets SGR after a full reset', async () => {
        const encoder = await setup('\u{1B}[?1000;1006h\u{1B}c\u{1B}[?1000h');
        expect(encoder.encode({ col: 1, lines: -1, row: 1 })).toBe('\u{1B}[M`!!');
    });
});

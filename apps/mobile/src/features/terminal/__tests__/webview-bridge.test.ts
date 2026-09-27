import { describe, expect, it } from 'vitest';

import { parseTerminalWebviewMessage, terminalWebviewCommandScript } from '../webview-bridge';

describe('mobile Terminal WebView bridge', () => {
    it('accepts only bounded messages from the current Terminal document', () => {
        expect(
            parseTerminalWebviewMessage(
                JSON.stringify({ version: 1, type: 'ready', terminalId: 'terminal-1' }),
                'terminal-1',
            ),
        ).toEqual({ version: 1, type: 'ready', terminalId: 'terminal-1' });
        expect(
            parseTerminalWebviewMessage(
                JSON.stringify({ version: 1, type: 'ready', terminalId: 'other' }),
                'terminal-1',
            ),
        ).toBeNull();
        expect(
            parseTerminalWebviewMessage(
                JSON.stringify({
                    version: 1,
                    type: 'ready',
                    terminalId: 'terminal-1',
                    url: 'https://bad.example',
                }),
                'terminal-1',
            ),
        ).toBeNull();
        expect(parseTerminalWebviewMessage('x'.repeat(2_049), 'terminal-1')).toBeNull();
    });

    it('accepts a bare tap so the native side can open the keyboard', () => {
        expect(
            parseTerminalWebviewMessage(
                JSON.stringify({ version: 1, type: 'tap', terminalId: 'terminal-1' }),
                'terminal-1',
            ),
        ).toEqual({ version: 1, type: 'tap', terminalId: 'terminal-1' });
        expect(
            parseTerminalWebviewMessage(
                JSON.stringify({ version: 1, type: 'tap', terminalId: 'terminal-1', x: 4 }),
                'terminal-1',
            ),
        ).toBeNull();
    });

    it('puts untrusted Terminal output only in hexadecimal data, never JavaScript source', () => {
        const script = terminalWebviewCommandScript({
            version: 1,
            type: 'append',
            terminalId: 'terminal-1',
            data: "</script><img src='https://bad.example'>",
        });
        expect(script).toContain('window.CaxriTerminal.receiveHex(');
        expect(script).not.toContain('bad.example');
        expect(script).toMatch(/^[\w.(');]+$/u);
    });

    it('bounds the grid a resize command may apply', () => {
        const resize = (cols: number, rows: number) => () =>
            terminalWebviewCommandScript({
                version: 1,
                type: 'resize',
                terminalId: 'terminal-1',
                cols,
                rows,
            });
        expect(resize(48, 35)).not.toThrow();
        expect(resize(1, 35)).toThrow();
        expect(resize(48, 1_001)).toThrow();
    });

    it('accepts only a bounded, non-empty wheel frame at a grid cell', () => {
        const wheel = (lines: number, col = 4) =>
            parseTerminalWebviewMessage(
                JSON.stringify({
                    version: 1,
                    type: 'wheel',
                    terminalId: 'terminal-1',
                    lines,
                    col,
                    row: 2,
                }),
                'terminal-1',
            );
        expect(wheel(-3)).toEqual({
            version: 1,
            type: 'wheel',
            terminalId: 'terminal-1',
            lines: -3,
            col: 4,
            row: 2,
        });
        expect(wheel(0)).toBeNull();
        expect(wheel(51)).toBeNull();
        expect(wheel(1, 0)).toBeNull();
    });
});

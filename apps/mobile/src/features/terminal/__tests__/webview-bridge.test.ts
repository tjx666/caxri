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
});

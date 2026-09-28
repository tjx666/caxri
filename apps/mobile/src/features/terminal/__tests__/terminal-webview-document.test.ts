import { describe, expect, it } from 'vitest';

import { terminalWebviewDocument } from '../terminal-webview-document';

describe('offline Terminal document', () => {
    it('uses bundled xterm assets, a content security policy, and a validated identity', () => {
        const html = terminalWebviewDocument('terminal-1');
        expect(html).toContain('window.__CAXRI_TERMINAL_ID__="terminal-1"');
        expect(html).toContain("connect-src 'none'");
        expect(html).toContain("default-src 'none'");
        expect(html).not.toContain('src="https://');
        expect(() => terminalWebviewDocument('x";fetch("https://bad.example")')).toThrow();
    });

    it('embeds the terminal faces offline so Android does not fall back to its system monospace', () => {
        const html = terminalWebviewDocument('terminal-1');
        expect(html).toContain('font-src data:');
        for (const family of ['Caxri JetBrains Mono', 'Caxri Symbols'])
            expect(html).toMatch(
                new RegExp(
                    String.raw`@font-face\{font-family:'${family}';[^}]*src:url\(data:font/woff2;base64,`,
                    'u',
                ),
            );
    });
});

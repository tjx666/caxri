import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { terminalWebviewHtml } from '../../src/features/terminal/terminal-webview.generated';
import { embedXtermLicenseComment } from '../terminal-webview-license';

const commentPattern = /\n<!-- Xterm license\n([\s\S]*?)-->/u;
const xtermLicense = fileURLToPath(
    new URL('../../../../licenses/XTERM_LICENSE.txt', import.meta.url),
);

describe('Terminal WebView Xterm license', () => {
    it('preserves the complete license without changing the JavaScript or CSS input', () => {
        const html =
            '<!doctype html>\n<html><head><style>.xterm{color:red}</style></head><body><script>window.value="unchanged"</script></body></html>';
        const licenseText = 'license line one\nlicense line two\n';
        const license = new TextEncoder().encode(licenseText);

        const result = embedXtermLicenseComment(html, license);
        const match = commentPattern.exec(result);

        expect(match).not.toBeNull();
        expect(match?.[1]).toBe(licenseText);
        expect(result.replace(commentPattern, '')).toBe(html);
        expect(result.match(/-->/gu)).toHaveLength(1);
    });

    it('fails closed for a missing license or an unexpected document boundary', () => {
        expect(() => embedXtermLicenseComment('<!doctype html>', new Uint8Array())).toThrow(
            'Xterm license must not be empty',
        );
        expect(() =>
            embedXtermLicenseComment('<html></html>', new TextEncoder().encode('license')),
        ).toThrow('Terminal document must start with its doctype');
        expect(() =>
            embedXtermLicenseComment('<!doctype html>', new Uint8Array([0xc3, 0x28])),
        ).toThrow('Xterm license must be valid UTF-8');
        expect(() =>
            embedXtermLicenseComment('<!doctype html>', new TextEncoder().encode('unsafe -- text')),
        ).toThrow('Xterm license must not contain an HTML comment boundary');
        expect(() =>
            embedXtermLicenseComment('<!doctype html>', new TextEncoder().encode('unsafe\0text')),
        ).toThrow('Xterm license must not contain NUL bytes');
    });

    it('keeps the complete repository Xterm license in the generated artifact', async () => {
        const match = commentPattern.exec(terminalWebviewHtml);

        expect(match).not.toBeNull();
        expect(match?.[1]).toBe(await readFile(xtermLicense, 'utf8'));
    });
});

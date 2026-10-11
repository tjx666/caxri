import { describe, expect, it } from 'vitest';

import { findInlineLoader, InlinePdfBinaryDataFactory } from '../pdf-binary-data';

describe('findInlineLoader', () => {
    const loaders = {
        '../node_modules/pdfjs-dist/cmaps/UniJIS-UCS2-H.bcmap': () => Promise.resolve('a'),
        '../node_modules/pdfjs-dist/cmaps/H.bcmap': () => Promise.resolve('b'),
    };

    it('matches the whole basename, not a suffix of another file name', async () => {
        await expect(findInlineLoader(loaders, 'H.bcmap')?.()).resolves.toBe('b');
        expect(findInlineLoader(loaders, 'S-H.bcmap')).toBeUndefined();
    });
});

describe('InlinePdfBinaryDataFactory', () => {
    it('serves a bundled standard font as bytes', async () => {
        const bytes = await new InlinePdfBinaryDataFactory().fetch({
            kind: 'standardFontDataUrl',
            filename: 'FoxitSymbol.pfb',
        });

        expect(bytes.byteLength).toBeGreaterThan(1000);
    });

    it('serves a WebAssembly image decoder as a wasm module', async () => {
        const bytes = await new InlinePdfBinaryDataFactory().fetch({
            kind: 'wasmUrl',
            filename: 'openjpeg.wasm',
        });

        expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    });

    it.each([
        ['wasmUrl', 'quickjs-eval.wasm'],
        ['wasmUrl', 'qcms_bg.wasm'],
        ['standardFontDataUrl', 'LiberationSans-Regular.ttf'],
    ])('does not bundle %s %s, which pdf.js never requests here', async (kind, filename) => {
        await expect(new InlinePdfBinaryDataFactory().fetch({ kind, filename })).rejects.toThrow(
            `No bundled PDF data for ${kind} ${filename}`,
        );
    });
});

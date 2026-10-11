/**
 * Built-in data pdf.js asks for while it parses: Adobe CMaps for CJK text in fonts the PDF does not embed, the Symbol
 * and ZapfDingbats standard fonts, and the WebAssembly image decoders (JBIG2 scans, JPEG 2000).
 *
 * Pdf.js normally fetches these by URL, but the packaged Renderer is a `file://` page, where `fetch` cannot read
 * application files, and its CSP allows `connect-src 'self'` only. Each file is instead imported as an inline module
 * that its own lazy chunk carries, so a document that needs one CMap loads that CMap and nothing else, and a document
 * that needs none pays only for this table of loaders.
 */
import { decodeBase64 } from './preview-asset-client';

type InlineLoader = () => Promise<string>;

const cMaps = import.meta.glob<string>('../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
    query: '?inline',
    import: 'default',
});
/**
 * Only the two symbol fonts: with `useSystemFonts` at its browser default, pdf.js substitutes a local system font for
 * every other non-embedded standard font and never requests its data.
 */
const standardFonts = import.meta.glob<string>(
    '../../../../../node_modules/pdfjs-dist/standard_fonts/Foxit{Symbol,Dingbats}.pfb',
    { query: '?inline', import: 'default' },
);
/**
 * Only the image decoders. `qcms_bg.wasm` (ICC color) is never requested: pdf.js disables ICC conversion when
 * `useWorkerFetch` is off, and renders ICC-based colors through their alternate color space instead.
 * `quickjs-eval.wasm` backs PDF scripting, which this viewer never enables.
 */
const wasmModules = import.meta.glob<string>(
    [
        '../../../../../node_modules/pdfjs-dist/wasm/jbig2.wasm',
        '../../../../../node_modules/pdfjs-dist/wasm/openjpeg.wasm',
    ],
    { query: '?inline', import: 'default' },
);

const loadersByKind: Record<string, Record<string, InlineLoader>> = {
    cMapUrl: cMaps,
    standardFontDataUrl: standardFonts,
    wasmUrl: wasmModules,
};

/**
 * Finds the loader for `filename` by its basename, since the glob keys carry the relative path they were matched by.
 */
export function findInlineLoader(
    loaders: Record<string, InlineLoader>,
    filename: string,
): InlineLoader | undefined {
    const suffix = `/${filename}`;
    for (const [key, loader] of Object.entries(loaders)) if (key.endsWith(suffix)) return loader;
    return undefined;
}

/**
 * The `BinaryDataFactory` pdf.js calls on the main thread when `useWorkerFetch` is off. pdf.js constructs it with the
 * factory URLs, which this implementation does not need.
 */
export class InlinePdfBinaryDataFactory {
    async fetch({
        kind,
        filename,
    }: {
        kind: string;
        filename: string;
    }): Promise<Uint8Array<ArrayBuffer>> {
        const loaders = loadersByKind[kind] as Record<string, InlineLoader> | undefined;
        const loader = loaders ? findInlineLoader(loaders, filename) : undefined;
        if (!loader) throw new Error(`No bundled PDF data for ${kind} ${filename}`);
        const dataUrl = await loader();
        return decodeBase64(dataUrl.slice(dataUrl.indexOf(',') + 1));
    }
}

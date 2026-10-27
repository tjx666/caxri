import type { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pngDimensions } from './png-dimensions';
import type { PromoImage, PromoLayoutInput } from './promo-layout';
import { PROMO_SCALE, renderPromoHtml } from './promo-layout';
import { renderPromoPng } from './promo-render';

/**
 * Byte budget of one promo PNG; the README hero is fetched by every visitor of the repository page.
 */
const MAX_BYTES = 3 * 1024 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function loadImage(path: string): Promise<PromoImage> {
    const buffer = await readFile(path);
    const { width, height } = pngDimensions(buffer);
    return { dataUri: `data:image/png;base64,${buffer.toString('base64')}`, width, height };
}

/**
 * Composes one promo image from a desktop capture and an Android capture with the repository logo, and replaces
 * `outPath` only once the result passes its size and byte checks. `htmlPath` also keeps the layout document for
 * inspection.
 */
export async function composePromoImage(options: {
    layout: PromoLayoutInput['layout'];
    canvas: PromoLayoutInput['canvas'];
    headline: string;
    subhead?: string;
    desktopPath: string;
    mobilePath: string;
    desktopScale: number;
    outPath: string;
    htmlPath?: string;
}): Promise<{ png: Buffer; width: number; height: number }> {
    const [desktop, mobile, logo] = await Promise.all([
        loadImage(options.desktopPath),
        loadImage(options.mobilePath),
        loadImage(resolve(repoRoot, 'build/icon.png')),
    ]);
    const html = renderPromoHtml({
        layout: options.layout,
        canvas: options.canvas,
        headline: options.headline,
        subhead: options.subhead,
        logo,
        desktop,
        mobile,
        desktopScale: options.desktopScale,
    });
    if (options.htmlPath) await writeFile(options.htmlPath, html);
    const png = await renderPromoPng(html, {
        ...options.canvas,
        scale: PROMO_SCALE,
        outPath: options.outPath,
        maxBytes: MAX_BYTES,
    });
    return {
        png,
        width: options.canvas.width * PROMO_SCALE,
        height: options.canvas.height * PROMO_SCALE,
    };
}

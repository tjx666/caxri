import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';

import { assertPromoPng, pngDimensions } from './png-dimensions';
import { renderPromoHtml } from './promo-layout';
import { renderHtmlToPng, renderPromoPng } from './promo-render';

const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const DATA_URI = `data:image/png;base64,${PIXEL}`;

async function inTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-promo-render-test-'));
    try {
        await run(directory);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}

/**
 * Renders and returns the failure (if any); skips the test when the Chromium headless shell is not installed.
 */
async function renderOrSkip(
    context: TestContext,
    html: string,
    options: Parameters<typeof renderHtmlToPng>[1] & { maxBytes?: number },
): Promise<unknown> {
    try {
        if (options.maxBytes === undefined) await renderHtmlToPng(html, options);
        else await renderPromoPng(html, { ...options, maxBytes: options.maxBytes });
        return undefined;
    } catch (error) {
        if (error instanceof Error && error.message.includes('headless shell is not installed')) {
            context.skip(
                'Chromium headless shell is not installed; run `bunx playwright install chromium-headless-shell`.',
            );
        }
        return error;
    }
}

/**
 * A 1200x675 hero; the layout trusts the claimed natural sizes, so one 1x1 PNG stands in for every capture.
 */
const HERO: Parameters<typeof renderPromoHtml>[0] = {
    layout: 'hero-desktop-mobile',
    canvas: { width: 1200, height: 675 },
    headline: 'Synthetic headline',
    subhead: 'Synthetic subhead',
    logo: { dataUri: DATA_URI, width: 1024, height: 1024 },
    desktop: { dataUri: DATA_URI, width: 2560, height: 1600 },
    mobile: { dataUri: DATA_URI, width: 1080, height: 2400 },
    desktopScale: 2,
};

describe('renderHtmlToPng', () => {
    it('renders the full hero layout to a decodable PNG exactly twice the canvas', async (context) => {
        await inTemporaryDirectory(async (directory) => {
            const outPath = join(directory, 'nested', 'out.png');
            expect(
                await renderOrSkip(context, renderPromoHtml(HERO), {
                    ...HERO.canvas,
                    scale: 2,
                    outPath,
                }),
            ).toBeUndefined();
            const png = await readFile(outPath);
            expect(pngDimensions(png)).toEqual({ width: 2400, height: 1350 });
            await assertPromoPng(png, { width: 2400, height: 1350, maxBytes: 3 * 1024 * 1024 });
        });
    }, 60_000);

    it('rejects copy that would be cut off or run into the desktop window', async (context) => {
        const html = renderPromoHtml({
            ...HERO,
            headline:
                'A headline long enough to need more than the two lines the layout allows it '.repeat(
                    3,
                ),
        });
        await inTemporaryDirectory(async (directory) => {
            const error = await renderOrSkip(context, html, {
                ...HERO.canvas,
                scale: 2,
                outPath: join(directory, 'long.png'),
            });
            expect((error as Error).message).toMatch(/does not fit: the headline is cut off/u);
        });
    }, 60_000);

    it('keeps the published image when a new render fails its gate', async (context) => {
        await inTemporaryDirectory(async (directory) => {
            const outPath = join(directory, 'hero.png');
            await writeFile(outPath, 'published');
            const error = await renderOrSkip(context, renderPromoHtml(HERO), {
                ...HERO.canvas,
                scale: 2,
                outPath,
                maxBytes: 10,
            });
            expect((error as Error).message).toMatch(/over the 10 byte budget/u);
            expect(await readFile(outPath, 'utf8')).toBe('published');
            expect(await readdir(directory)).toEqual(['hero.png']);
        });
    }, 60_000);

    it('rejects when an embedded image cannot be decoded instead of rendering it blank', async (context) => {
        await inTemporaryDirectory(async (directory) => {
            const html = `<!doctype html><img src="data:image/png;base64,${Buffer.from('not a png').toString('base64')}">`;
            const error = await renderOrSkip(context, html, {
                width: 100,
                height: 100,
                scale: 2,
                outPath: join(directory, 'broken.png'),
            });
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toMatch(/cannot be decoded/u);
        });
    }, 60_000);
});

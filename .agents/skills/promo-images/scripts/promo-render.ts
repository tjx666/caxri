import type { Buffer } from 'node:buffer';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import type { Browser } from 'playwright';
import { chromium } from 'playwright';

import { assertPromoPng } from './png-dimensions';

const MISSING_BROWSER_HINT =
    'The Chromium headless shell is not installed. Run `bunx playwright install chromium-headless-shell` and retry.';

async function launchChromium(): Promise<Browser> {
    try {
        return await chromium.launch({ headless: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            message.includes("Executable doesn't exist")
                ? `${MISSING_BROWSER_HINT}\n${message}`
                : message,
            { cause: error },
        );
    }
}

/**
 * Renders a self-contained HTML document to a PNG with headless Chromium. The viewport is the canvas and the device
 * scale factor multiplies it, so a 1200x675 canvas at `scale: 2` writes a 2400x1350 PNG. Resolves after the image has
 * been written; rejects when the browser is missing, an image fails to decode, the page cannot load, or the laid-out
 * page breaks a fit rule a layout declares in its markup:
 *
 * - `data-promo-fit="<name>"`: the element shows all of its content (a line clamp cut nothing off).
 * - `data-promo-apart="<name>"`: the element does not overlap any other `data-promo-apart` element.
 *
 * Failing here keeps a clipped or colliding hero from being written at all.
 */
export async function renderHtmlToPng(
    html: string,
    options: { width: number; height: number; scale: 2; outPath: string },
): Promise<void> {
    const browser = await launchChromium();
    try {
        const context = await browser.newContext({
            viewport: { width: options.width, height: options.height },
            deviceScaleFactor: options.scale,
            reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        // `load` does not guarantee decoded pixels for a large data URI, and a screenshot taken early paints a
        // blank image. `decode()` also rejects on a corrupt PNG, so a bad capture fails here instead of rendering empty.
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((image) => image.decode()));
        });
        const problems = await page.evaluate(() => {
            const found: string[] = [];
            const fitted = document.querySelectorAll<HTMLElement>('[data-promo-fit]');
            for (const element of fitted) {
                if (element.scrollHeight > element.clientHeight + 1)
                    found.push(`the ${element.dataset.promoFit} is cut off`);
            }
            const apart = [...document.querySelectorAll<HTMLElement>('[data-promo-apart]')];
            apart.forEach((first, index) => {
                const a = first.getBoundingClientRect();
                const later = apart.slice(index + 1);
                for (const second of later) {
                    const b = second.getBoundingClientRect();
                    if (
                        a.left < b.right &&
                        b.left < a.right &&
                        a.top < b.bottom &&
                        b.top < a.bottom
                    )
                        found.push(
                            `the ${first.dataset.promoApart} overlaps the ${second.dataset.promoApart}`,
                        );
                }
            });
            return found;
        });
        if (problems.length > 0) {
            throw new Error(
                `The layout does not fit: ${problems.join('; ')}. Shorten the copy or enlarge the canvas.`,
            );
        }
        const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
        await mkdir(dirname(options.outPath), { recursive: true });
        await writeFile(options.outPath, png);
    } finally {
        await browser.close();
    }
}

/**
 * Renders `html` like `renderHtmlToPng`, checks the result with `assertPromoPng`, and only then replaces `outPath`, so
 * a failed run (copy that does not fit, a PNG over budget) leaves the image already published there untouched. Resolves
 * with the bytes written.
 */
export async function renderPromoPng(
    html: string,
    options: { width: number; height: number; scale: 2; outPath: string; maxBytes: number },
): Promise<Buffer> {
    const { outPath, maxBytes, ...render } = options;
    const partialPath = join(dirname(outPath), `.${basename(outPath)}.${process.pid}.partial.png`);
    try {
        await renderHtmlToPng(html, { ...render, outPath: partialPath });
        const png = await readFile(partialPath);
        await assertPromoPng(png, {
            width: render.width * render.scale,
            height: render.height * render.scale,
            maxBytes,
        });
        await rename(partialPath, outPath);
        return png;
    } finally {
        await rm(partialPath, { force: true });
    }
}

/**
 * Composes one promo image from a desktop capture and an Android capture, then verifies the PNG.
 *
 * Usage:
 *
 * ```sh
 * bun run .agents/skills/promo-images/scripts/promo-compose.ts --desktop <png> --mobile <png> --out <png> \
 *     --headline <text> [--subhead <text>] [--canvas 1200x675] [--desktop-scale 2] [--html <path>]
 * ```
 *
 * Writes the PNG at twice the canvas size (default 2400x1350). `--html` also writes the layout document for inspection.
 * The logo is `build/icon.png`. Exits 1 with the reason when an input is unusable, the copy does not fit, or the result
 * misses the size or byte budget; an existing `--out` file is left untouched on failure.
 */
import { resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { composePromoImage } from './promo-image';

function parseCanvas(value: string): { width: number; height: number } {
    const match = /^(\d+)x(\d+)$/u.exec(value);
    if (!match) throw new Error(`--canvas must look like 1200x675, received ${value}`);
    return { width: Number(match[1]), height: Number(match[2]) };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            'desktop': { type: 'string' },
            'mobile': { type: 'string' },
            'out': { type: 'string' },
            'headline': { type: 'string' },
            'subhead': { type: 'string' },
            'canvas': { type: 'string', default: '1200x675' },
            'desktop-scale': { type: 'string', default: '2' },
            'html': { type: 'string' },
        },
        strict: true,
    });
    const { desktop: desktopPath, mobile: mobilePath, out, headline } = values;
    if (!desktopPath || !mobilePath || !out || !headline) {
        throw new Error(
            'Required options: --desktop <png> --mobile <png> --out <png> --headline <text>',
        );
    }
    const outPath = resolve(out);
    const result = await composePromoImage({
        layout: 'hero-desktop-mobile',
        canvas: parseCanvas(values.canvas),
        headline,
        subhead: values.subhead,
        desktopPath: resolve(desktopPath),
        mobilePath: resolve(mobilePath),
        desktopScale: Number(values['desktop-scale']),
        outPath,
        htmlPath: values.html && resolve(values.html),
    });
    console.log(
        `ok - ${outPath} (${result.width}x${result.height}, ${Math.round(result.png.length / 1024)} KiB)`,
    );
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

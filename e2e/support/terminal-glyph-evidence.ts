import { Buffer } from 'node:buffer';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { E2EApp } from './electron-app.ts';
import type { Page } from './fixtures.ts';
import { expect } from './fixtures.ts';

interface TerminalGlyphPixels {
    deviceX: number;
    foregroundPixels: number;
}

export async function createTerminalGlyphFixture(directory: string): Promise<string> {
    const output = join(directory, 'terminal-glyph-output.sh');
    await writeFile(
        output,
        String.raw`#!/bin/sh
i=0
while [ "$i" -lt 80 ]; do printf 'filler-%03d\n' "$i"; i=$((i + 1)); done
cols=$(tput cols)
if [ "$1" = ascii ]; then
  for offset in 2 3 4 5 6 7 8 9 10 11 12; do
    if [ "$offset" -lt "$((cols - 1))" ]; then printf '%*sW\n' "$((cols - 1 - offset))" ''; fi
  done
  printf '%*sW\n' "$((cols - 1))" ''
else
  for offset in 2 3 4 5 6 7 8 9 10 11 12; do
    if [ "$offset" -lt "$((cols - 2))" ]; then printf '%*s界\n' "$((cols - 2 - offset))" ''; fi
  done
  printf '%*s界\n' "$((cols - 2))" ''
fi
sleep 30
`,
        'utf8',
    );
    await chmod(output, 0o700);
    return output;
}

async function terminalGlyphPixelCounts(
    app: E2EApp,
    page: Page,
    terminalId: string,
    glyph: string,
): Promise<TerminalGlyphPixels[]> {
    const pane = page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`);
    const geometry = await pane.evaluate((paneElement, target) => {
        /**
         * Locate the DOM range for `target` inside a single row's text nodes, if present. Extracted so the outer row
         * loop below can `continue` without nesting a `break` inside two loop levels
         * (unicorn/no-break-in-nested-loop).
         */
        function findRowMatch(row: Element, matchTarget: string) {
            const text = row.textContent;
            if (text.trim() !== matchTarget) return null;
            const index = text.indexOf(matchTarget);
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let offset = 0;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const length = node.textContent?.length ?? 0;
                if (index < offset || index + matchTarget.length > offset + length) {
                    offset += length;
                    continue;
                }
                const range = document.createRange();
                range.setStart(node, index - offset);
                range.setEnd(node, index + matchTarget.length - offset);
                return range.getBoundingClientRect();
            }
            return null;
        }

        const paneBounds = paneElement.getBoundingClientRect();
        const screenElement = paneElement.querySelector('.xterm-screen');
        if (!screenElement) throw new Error('Terminal screen is unavailable');
        const rows = screenElement.querySelector('.xterm-rows');
        if (!rows) throw new Error('Terminal rows are unavailable');
        const matches: Array<{ height: number; width: number; x: number; y: number }> = [];
        for (const row of rows.children) {
            const bounds = findRowMatch(row, target);
            if (!bounds) continue;
            matches.push({
                height: bounds.height,
                width: bounds.width,
                x: bounds.x - paneBounds.x,
                y: bounds.y - paneBounds.y,
            });
        }
        return { height: paneBounds.height, matches, width: paneBounds.width };
    }, glyph);
    const screenshot = await pane.screenshot();
    return app.evaluate(
        ({ nativeImage }, { geometry, screenshotBase64 }) => {
            const image = nativeImage.createFromBuffer(Buffer.from(screenshotBase64, 'base64'));
            const size = image.getSize();
            const bitmap = image.toBitmap();
            const scaleX = size.width / geometry.width;
            const scaleY = size.height / geometry.height;
            return geometry.matches.map((bounds) => {
                const left = Math.max(0, Math.floor((bounds.x - 3) * scaleX));
                const right = Math.min(
                    size.width,
                    Math.ceil((bounds.x + bounds.width + 3) * scaleX),
                );
                const top = Math.max(0, Math.floor(bounds.y * scaleY));
                const bottom = Math.min(
                    size.height,
                    Math.ceil((bounds.y + bounds.height) * scaleY),
                );
                let foregroundPixels = 0;
                for (let y = top; y < bottom; y += 1) {
                    for (let x = left; x < right; x += 1) {
                        const offset = (y * size.width + x) * 4;
                        if (Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]) > 96)
                            foregroundPixels += 1;
                    }
                }
                return { deviceX: bounds.x * scaleX, foregroundPixels };
            });
        },
        { geometry, screenshotBase64: screenshot.toString('base64') },
    );
}

function alignedTerminalGlyphs(samples: TerminalGlyphPixels[]): {
    edge: TerminalGlyphPixels;
    reference: TerminalGlyphPixels;
} {
    const edge = samples.at(-1);
    if (!edge || samples.length < 2) throw new Error('Terminal glyph samples are incomplete');
    const edgeFraction = edge.deviceX - Math.floor(edge.deviceX);
    const reference = samples.slice(0, -1).reduce((closest, candidate) => {
        const candidateFraction = candidate.deviceX - Math.floor(candidate.deviceX);
        const closestFraction = closest.deviceX - Math.floor(closest.deviceX);
        const candidateDistance = Math.min(
            Math.abs(candidateFraction - edgeFraction),
            1 - Math.abs(candidateFraction - edgeFraction),
        );
        const closestDistance = Math.min(
            Math.abs(closestFraction - edgeFraction),
            1 - Math.abs(closestFraction - edgeFraction),
        );
        return candidateDistance < closestDistance ? candidate : closest;
    });
    return { edge, reference };
}

export async function terminalEdgeGlyphEvidence(
    app: E2EApp,
    page: Page,
    terminalId: string,
    output: string,
    {
        ascii: minimumAsciiSamples = 3,
        cjk: minimumCjkSamples = 3,
    }: { ascii?: number; cjk?: number } = {},
): Promise<{
    alignedAscii: ReturnType<typeof alignedTerminalGlyphs>;
    alignedCjk: ReturnType<typeof alignedTerminalGlyphs>;
}> {
    const input = page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
    );
    const rows = page.locator(`.terminal-pane[data-terminal-id="${terminalId}"] .xterm-rows`);
    await input.focus();
    await input.press('Control+L');
    await input.pressSequentially(`${output} ascii`);
    await input.press('Enter');
    await expect
        .poll(() =>
            rows.evaluate(
                (rowContainer) =>
                    [...rowContainer.children].filter((row) => row.textContent.trim() === 'W')
                        .length,
            ),
        )
        .toBeGreaterThanOrEqual(minimumAsciiSamples);
    const ascii = await terminalGlyphPixelCounts(app, page, terminalId, 'W');
    await input.press('Control+C');

    await input.focus();
    await input.press('Control+L');
    await input.pressSequentially(`${output} cjk`);
    await input.press('Enter');
    await expect
        .poll(() =>
            rows.evaluate(
                (rowContainer) =>
                    [...rowContainer.children].filter((row) => row.textContent.trim() === '界')
                        .length,
            ),
        )
        .toBeGreaterThanOrEqual(minimumCjkSamples);
    const cjk = await terminalGlyphPixelCounts(app, page, terminalId, '界');
    await input.press('Control+C');
    expect(ascii.length).toBeGreaterThanOrEqual(minimumAsciiSamples);
    expect(cjk.length).toBeGreaterThanOrEqual(minimumCjkSamples);
    return {
        alignedAscii: alignedTerminalGlyphs(ascii),
        alignedCjk: alignedTerminalGlyphs(cjk),
    };
}

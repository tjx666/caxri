import { Buffer } from 'node:buffer';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import type { ThemeTokens } from '../src/shared/types.ts';
import type { ElectronApplication as ElectronApp, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';

interface TerminalGlyphPixels {
    deviceX: number;
    foregroundPixels: number;
}

async function terminalGlyphPixelCounts(
    app: ElectronApp,
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

async function terminalEdgeGlyphEvidence(
    app: ElectronApp,
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

test('Terminal split layout drags, resizes, restores, and preserves the live PTY', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-layout-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    let running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const firstTerminalId = (
            await pageRequest<{ terminals: Array<{ id: string }> }>(running.page, 'app.bootstrap')
        ).terminals[0].id;
        const initialInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`,
        );
        await initialInput.focus();
        await initialInput.pressSequentially('export CAXRI_SPLIT_CONTINUITY=alive');
        await initialInput.press('Enter');
        await initialInput.pressSequentially(String.raw`printf "$CAXRI_SPLIT_CONTINUITY\n"`);
        await initialInput.press('Enter');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('alive');
        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(running.page.locator('.terminal-group')).toHaveCount(2);
        const terminalSplitter = running.page.getByRole('separator', {
            name: /Terminal split/,
        });
        await expect(terminalSplitter).toHaveCount(1);
        const runningBeforeMove = await pageRequest<number>(running.page, 'terminal.runningCount');

        const splitterBox = await terminalSplitter.boundingBox();
        expect(splitterBox).not.toBeNull();
        await running.page.mouse.move(
            splitterBox!.x + splitterBox!.width / 2,
            splitterBox!.y + splitterBox!.height / 2,
        );
        await running.page.mouse.down();
        await running.page.mouse.move(
            splitterBox!.x + 80,
            splitterBox!.y + splitterBox!.height / 2,
        );
        await expect(terminalSplitter).not.toHaveAttribute('aria-valuenow', '50');
        await terminalSplitter.dispatchEvent('pointercancel', { pointerId: 1 });
        await running.page.mouse.up();
        await expect(terminalSplitter).toHaveAttribute('aria-valuenow', '50');

        const dragFirstTab = (targetIndex: number, xRatio: number, yRatio: number) =>
            running.page.evaluate(
                ({ firstTerminalId, targetIndex, xRatio, yRatio }) => {
                    const source = document.querySelector(
                        `.work-tab[data-terminal-id="${CSS.escape(firstTerminalId)}"]`,
                    );
                    // `NodeListOf`'s index signature (unlike `.item()`) types out-of-range access as
                    // always-defined; correct that here since `targetIndex` may be out of bounds.
                    const target = document.querySelectorAll('.terminal-group')[targetIndex] as
                        Element | undefined;
                    if (!source || !target) throw new Error('Terminal drag fixture not found');
                    const transfer = new DataTransfer();
                    const bounds = target.getBoundingClientRect();
                    const options = {
                        bubbles: true,
                        cancelable: true,
                        clientX: bounds.left + bounds.width * xRatio,
                        clientY: bounds.top + bounds.height * yRatio,
                        dataTransfer: transfer,
                    };
                    source.dispatchEvent(new DragEvent('dragstart', options));
                    target.dispatchEvent(new DragEvent('dragenter', options));
                    target.dispatchEvent(new DragEvent('dragover', options));
                    target.dispatchEvent(new DragEvent('drop', options));
                    source.dispatchEvent(new DragEvent('dragend', options));
                },
                { firstTerminalId, targetIndex, xRatio, yRatio },
            );
        await dragFirstTab(1, 0.5, 0.5);
        await expect(running.page.locator('.terminal-group')).toHaveCount(1);
        await dragFirstTab(0, 0.9, 0.5);
        await expect(running.page.locator('.terminal-group')).toHaveCount(2);

        const firstInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-helper-textarea`,
        );
        await firstInput.focus();
        await firstInput.pressSequentially(String.raw`printf "$CAXRI_SPLIT_CONTINUITY\n"`);
        await firstInput.press('Enter');
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('alive');
        await expect
            .poll(() => pageRequest<number>(running.page, 'terminal.runningCount'))
            .toBe(runningBeforeMove);

        await terminalSplitter.focus();
        await running.page.keyboard.press('ArrowRight');
        const savedRatio = (
            await pageRequest<{ sessionStates: Array<{ layout: { root?: { ratio?: number } } }> }>(
                running.page,
                'app.bootstrap',
            )
        ).sessionStates[0].layout.root?.ratio;
        expect(savedRatio).toBeCloseTo(0.55, 2);

        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect(running.page.locator('.terminal-group')).toHaveCount(2);
        await expect(
            running.page.getByRole('separator', { name: /Terminal split/ }),
        ).toHaveAttribute('aria-valuenow', '55');

        const restoredFirstTab = running.page.locator(
            `.work-tab[data-terminal-id="${firstTerminalId}"]`,
        );
        await restoredFirstTab.hover();
        await restoredFirstTab.locator('.tab-close').click();
        await expect(running.page.locator('.terminal-group')).toHaveCount(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Terminal scrollbar is flush while the terminal-colored inset keeps text clear', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-layout-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const activeTheme = await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get');
        const contrastingTheme = structuredClone(activeTheme.value);
        contrastingTheme.colors.background = '#101820';
        contrastingTheme.terminal.background = '#304050';
        await pageRequest(running.page, 'theme.update', {
            source: JSON.stringify(contrastingTheme),
        });
        await expect
            .poll(() =>
                running.page
                    .locator('.terminal-pane')
                    .first()
                    .evaluate((pane) => {
                        const viewport = pane.querySelector('.xterm-scrollable-element');
                        if (!viewport) throw new Error('Terminal viewport is unavailable');
                        return {
                            inset: getComputedStyle(pane).backgroundColor,
                            viewport: getComputedStyle(viewport).backgroundColor,
                        };
                    }),
            )
            .toEqual({ inset: 'rgb(48, 64, 80)', viewport: 'rgb(48, 64, 80)' });

        const terminalIds = (
            await pageRequest<{ terminals: Array<{ id: string }> }>(running.page, 'app.bootstrap')
        ).terminals.map((terminal) => terminal.id);
        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, terminalIds);
        await splitTerminalToRight(running.page, secondTerminalId);
        const terminalPanes = running.page.locator('.terminal-pane');
        await expect(terminalPanes).toHaveCount(2);

        const readGeometry = () =>
            terminalPanes.evaluateAll((panes) => {
                return panes.map((pane) => {
                    const paneBounds = pane.getBoundingClientRect();
                    const screen = pane.querySelector('.xterm-screen')?.getBoundingClientRect();
                    const scrollbar = pane
                        .querySelector(
                            ':scope .xterm-scrollable-element > .xterm-scrollbar.xterm-vertical',
                        )
                        ?.getBoundingClientRect();
                    if (!screen || !scrollbar) throw new Error('Terminal geometry is unavailable');
                    return {
                        edgeGap: paneBounds.right - scrollbar.right,
                        textGutter: scrollbar.left - screen.right,
                    };
                });
            });

        for (const width of [1_160, 1_300]) {
            // eslint-disable-next-line no-await-in-loop -- each viewport width must settle before the next resize.
            await running.page.setViewportSize({ width, height: 800 });
            /**
             * Xterm fits asynchronously after the viewport resize; measure only after both panes converge.
             */
            // eslint-disable-next-line no-await-in-loop -- each viewport width must settle before the next resize.
            await expect
                .poll(async () => {
                    const geometry = await readGeometry();
                    return geometry.every(
                        ({ edgeGap, textGutter }) => Math.abs(edgeGap) <= 1 && textGutter >= 4,
                    );
                })
                .toBe(true);
            // eslint-disable-next-line no-await-in-loop -- each viewport width must settle before the next resize.
            const geometry = await readGeometry();

            for (const [index, pane] of geometry.entries()) {
                expect(
                    Math.abs(pane.edgeGap),
                    `viewport width ${width}px, pane ${index}`,
                ).toBeLessThanOrEqual(1);
                expect(
                    pane.textGutter,
                    `viewport width ${width}px, pane ${index}`,
                ).toBeGreaterThanOrEqual(4);
            }
        }
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Terminal paints complete ASCII and CJK glyphs in the final grid cells', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-glyph-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const output = join(testDirectory, 'terminal-glyph-output.sh');
    await execFileAsync('mkdir', ['-p', root]);
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

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const activeTheme = await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get');
        const contrastingTheme = structuredClone(activeTheme.value);
        contrastingTheme.terminal.background = '#000000';
        contrastingTheme.terminal.foreground = '#ffffff';
        await pageRequest(running.page, 'theme.update', {
            source: JSON.stringify(contrastingTheme),
        });
        const terminalId = (
            await pageRequest<{ terminals: Array<{ id: string }> }>(running.page, 'app.bootstrap')
        ).terminals[0].id;
        const rows = running.page.locator(
            `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-rows`,
        );
        const settings = await pageRequest<{
            value: Record<string, unknown>;
        }>(running.page, 'settings.get');
        for (const { fontSize, width } of [
            { fontSize: 9, width: 900 },
            { fontSize: 9, width: 1_160 },
            { fontSize: 13, width: 900 },
            { fontSize: 13, width: 1_160 },
            { fontSize: 32, width: 900 },
            { fontSize: 32, width: 1_160 },
        ]) {
            // eslint-disable-next-line no-await-in-loop -- each font-size/width case must apply and settle before the next.
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify({
                    ...settings.value,
                    'terminal.fontSize': fontSize,
                }),
            });
            // eslint-disable-next-line no-await-in-loop -- each font-size/width case must apply and settle before the next.
            await running.page.setViewportSize({ height: 800, width });
            // eslint-disable-next-line no-await-in-loop -- each font-size/width case must apply and settle before the next.
            await expect
                .poll(() =>
                    // `getComputedStyle().fontSize` is a pixel string like "16px"; `Number()` would
                    // produce `NaN` here, so `Number.parseFloat` remains required.
                    rows.evaluate((element) => {
                        // eslint-disable-next-line unicorn/prefer-number-coercion
                        return Number.parseFloat(getComputedStyle(element).fontSize);
                    }),
                )
                .toBe(fontSize);
            // eslint-disable-next-line no-await-in-loop -- each font-size/width case must apply and settle before the next.
            await running.page.evaluate(
                () =>
                    new Promise<void>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    ),
            );
            // eslint-disable-next-line no-await-in-loop -- each font-size/width case must apply and settle before the next.
            const { alignedAscii, alignedCjk } = await terminalEdgeGlyphEvidence(
                running.app,
                running.page,
                terminalId,
                output,
            );
            const evidence = JSON.stringify({ alignedAscii, alignedCjk, fontSize, width });
            expect(alignedAscii.edge.foregroundPixels, evidence).toBeGreaterThanOrEqual(
                alignedAscii.reference.foregroundPixels * 0.95,
            );
            expect(alignedCjk.edge.foregroundPixels, evidence).toBeGreaterThanOrEqual(
                alignedCjk.reference.foregroundPixels * 0.95,
            );
        }

        await running.page.getByRole('button', { name: 'New Terminal' }).click();
        const secondTerminalId = await waitForNewTerminalId(running.page, [terminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({ ...settings.value, 'terminal.fontSize': 13 }),
        });
        await running.page.setViewportSize({ height: 800, width: 1_160 });
        const secondRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
        );
        await expect
            .poll(() =>
                // `getComputedStyle().fontSize` is a pixel string like "16px"; `Number()` would
                // produce `NaN` here, so `Number.parseFloat` remains required.
                secondRows.evaluate((element) => {
                    // eslint-disable-next-line unicorn/prefer-number-coercion
                    return Number.parseFloat(getComputedStyle(element).fontSize);
                }),
            )
            .toBe(13);
        await running.page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
        );
        const splitLeft = await terminalEdgeGlyphEvidence(
            running.app,
            running.page,
            terminalId,
            output,
        );
        const splitRight = await terminalEdgeGlyphEvidence(
            running.app,
            running.page,
            secondTerminalId,
            output,
            { ascii: 3, cjk: 2 },
        );
        for (const split of [splitLeft, splitRight]) {
            const splitEvidence = JSON.stringify(split);
            expect(split.alignedAscii.edge.foregroundPixels, splitEvidence).toBeGreaterThanOrEqual(
                split.alignedAscii.reference.foregroundPixels * 0.95,
            );
            expect(split.alignedCjk.edge.foregroundPixels, splitEvidence).toBeGreaterThanOrEqual(
                split.alignedCjk.reference.foregroundPixels * 0.95,
            );
        }
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

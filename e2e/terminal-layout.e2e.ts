import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThemeTokens } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    splitTerminalToRight,
    waitForNewTerminalId,
} from './support/helpers.ts';
import { pollUntil } from './support/polling.ts';
import { runningWork } from './support/running-work.ts';
import {
    createTerminalGlyphFixture,
    terminalEdgeGlyphEvidence,
} from './support/terminal-glyph-evidence.ts';

/**
 * Keep sampling the guest grid while the split layout settles. A one-shot `tput` result can become stale after a late
 * xterm fit, leaving an otherwise converged Renderer compared with old PTY data.
 */
async function waitForStableTerminalGrid(page: Page, terminalId: string): Promise<string> {
    const pane = page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`);
    const rows = pane.locator('.xterm-rows');
    const gridProbe = String.raw`printf 'CAXRI_PTY_GRID_%sx%s\n' "$(tput cols)" "$(tput lines)"`;
    /**
     * Moving a newly created Terminal into a split remounts xterm. Its DOM can appear before the asynchronous PTY
     * attachment and initial replay finish, so keyboard probes must wait for the Renderer-owned readiness boundary.
     */
    await expect(pane.locator('.terminal-surface[data-terminal-attached="true"]')).toBeVisible();
    /**
     * This helper verifies the Renderer/PTY grid, not keyboard routing. Send the probe through the Server contract so
     * an xterm remount cannot silently drop keystrokes while its local `disableStdin` state catches up.
     */
    const sendGridProbe = (leadingClear: string) =>
        pageRequest(page, 'terminal.input', {
            data: `${leadingClear}${gridProbe}\r`,
            terminalId,
        });
    /**
     * Form feed clears fixture output so the first reading cannot be mistaken for text already on the screen.
     */
    const sendFirstGridProbe = () => sendGridProbe('\u{C}');
    /**
     * A retry appends instead of clearing. Another form feed would erase an in-flight probe's output before it painted,
     * so under load every sample could land in that blank window and the comparison would never converge. Reading
     * `.at(-1)` already selects the newest reading out of the accumulated probe lines.
     */
    const sendRetryGridProbe = () => sendGridProbe('');
    await sendFirstGridProbe();

    let candidate: string | undefined;
    let matchingSamples = 0;
    let stableGrid: string | undefined;
    await expect
        .poll(async () => {
            const [rendererState, terminalText] = await Promise.all([
                pane.locator('.terminal-surface').evaluate((surface) => {
                    const terminalSurface = surface as HTMLElement;
                    const screen = terminalSurface.querySelector<HTMLElement>('.xterm-screen');
                    const terminal = terminalSurface.querySelector<HTMLElement>('.xterm');
                    const viewport = terminalSurface.querySelector<HTMLElement>('.xterm-viewport');
                    const scrollbar = terminalSurface.querySelector<HTMLElement>(
                        '.xterm-scrollbar.xterm-vertical',
                    );
                    const rendererGrid = terminalSurface.dataset.terminalGrid ?? null;
                    const columns = Number(rendererGrid?.split('x', 1)[0]);
                    if (
                        !screen ||
                        !terminal ||
                        !viewport ||
                        !rendererGrid ||
                        !Number.isFinite(columns)
                    )
                        return {
                            cellWidth: 0,
                            fillsPane: false,
                            horizontalPadding: 0,
                            rendererGrid,
                            scrollbarWidth: 0,
                            screenWidth: 0,
                            viewportWidth: 0,
                        };
                    const screenWidth = screen.getBoundingClientRect().width;
                    const viewportWidth = viewport.getBoundingClientRect().width;
                    const terminalStyle = getComputedStyle(terminal);
                    const horizontalPadding =
                        Number(terminalStyle.paddingLeft.slice(0, -2)) +
                        Number(terminalStyle.paddingRight.slice(0, -2));
                    const scrollbarWidth = scrollbar?.getBoundingClientRect().width ?? 0;
                    const cellWidth = screenWidth / columns;
                    return {
                        cellWidth,
                        fillsPane:
                            viewportWidth - screenWidth <=
                            horizontalPadding + scrollbarWidth + cellWidth * 2 + 2,
                        horizontalPadding,
                        rendererGrid,
                        scrollbarWidth,
                        screenWidth,
                        viewportWidth,
                    };
                }),
                rows.textContent(),
            ]);
            const ptyGrid = (terminalText ?? '')
                .match(/CAXRI_PTY_GRID_\d+x\d+/g)
                ?.at(-1)
                ?.slice('CAXRI_PTY_GRID_'.length);
            if (
                !rendererState.rendererGrid ||
                !rendererState.fillsPane ||
                rendererState.rendererGrid !== ptyGrid
            ) {
                candidate = undefined;
                matchingSamples = 0;
                await sendRetryGridProbe();
                return { ...rendererState, ptyGrid, stable: false };
            }
            const rendererGrid = rendererState.rendererGrid;
            if (rendererGrid === candidate) matchingSamples += 1;
            else {
                candidate = rendererGrid;
                matchingSamples = 1;
            }
            if (matchingSamples < 3) return { ...rendererState, ptyGrid, stable: false };
            stableGrid = rendererGrid;
            return { ...rendererState, ptyGrid, stable: true };
        })
        .toMatchObject({ fillsPane: true, stable: true });
    return stableGrid!;
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
        const firstPane = running.page.locator(
            `.terminal-pane[data-terminal-id="${firstTerminalId}"]`,
        );
        /**
         * Layout remounts can expose the textarea before PTY replay finishes. Like the grid probe above, verify
         * continuity through the input contract after attachment; keyboard routing has separate coverage.
         * Stage-specific formatted output cannot match command echo or a previous probe's successful output.
         */
        await expect(
            firstPane.locator('.terminal-surface[data-terminal-attached="true"]'),
        ).toBeVisible();
        await pageRequest(running.page, 'terminal.input', {
            data: `${String.raw`export CAXRI_SPLIT_CONTINUITY=alive; printf 'CAXRI_SPLIT_INITIAL_%s_END\n' "$CAXRI_SPLIT_CONTINUITY"`}\r`,
            terminalId: firstTerminalId,
        });
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('CAXRI_SPLIT_INITIAL_alive_END');
        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        const terminalSplitter = running.page.getByRole('separator', {
            name: /Resize .* split/,
        });
        await expect(terminalSplitter).toHaveCount(1);
        const runningBeforeMove = await runningWork(running.page);

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
                    // always-defined; correct that here since `targetIndex` may be out of bounds. The actual drop
                    // listeners live on `.pane-surface`, the content area beneath a pane's tab bar, not on the
                    // outer `.workbench-pane` box.
                    const target = document.querySelectorAll('.workbench-pane .pane-surface')[
                        targetIndex
                    ] as Element | undefined;
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
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
        await dragFirstTab(0, 0.9, 0.5);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);

        await expect(
            firstPane.locator('.terminal-surface[data-terminal-attached="true"]'),
        ).toBeVisible();
        await pageRequest(running.page, 'terminal.input', {
            data: `${String.raw`printf 'CAXRI_SPLIT_MOVED_%s_END\n' "$CAXRI_SPLIT_CONTINUITY"`}\r`,
            terminalId: firstTerminalId,
        });
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${firstTerminalId}"] .xterm-rows`,
            ),
        ).toContainText('CAXRI_SPLIT_MOVED_alive_END');
        await expect.poll(() => runningWork(running.page)).toEqual(runningBeforeMove);

        await terminalSplitter.focus();
        await running.page.keyboard.press('ArrowRight');
        const savedRatio = (
            await pageRequest<{
                sessionStates: Array<{ paneLayout: { root?: { ratio?: number } } }>;
            }>(running.page, 'app.bootstrap')
        ).sessionStates[0].paneLayout.root?.ratio;
        expect(savedRatio).toBeCloseTo(0.55, 2);

        await running.app.close();
        running = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        await expect(
            running.page.getByRole('separator', { name: /Resize .* split/ }),
        ).toHaveAttribute('aria-valuenow', '55');

        const restoredFirstTab = running.page.locator(
            `.work-tab[data-terminal-id="${firstTerminalId}"]`,
        );
        await restoredFirstTab.hover();
        await restoredFirstTab.locator('.tab-close').click();
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

/**
 * The grid is fitted to the space left of the slider, so whatever the column count could not fill stays between the
 * last glyph and the slider: strictly less than one cell, because a full cell's worth would have become another column.
 * At the default 13px monospace that cell is about 8px, so 12 separates "rounding slack" from "a second reservation",
 * which is the defect this bounds. Caxri used to subtract a whole extra column on top of the addon's own scrollbar
 * reservation, leaving a right inset near twice the 20px shell-integration gutter on the left (issue #1100). A negative
 * gutter is the opposite failure: text running under the slider.
 */
const MAX_TEXT_GUTTER = 12;

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
        const insetColors = await pollUntil(
            () =>
                running.page
                    .locator('.terminal-pane')
                    .first()
                    .evaluate((pane) => {
                        const overviewRuler = pane.querySelector<HTMLCanvasElement>(
                            '.xterm-decoration-overview-ruler',
                        );
                        const scrollable = pane.querySelector('.xterm-scrollable-element');
                        const overviewRulerContext = overviewRuler?.getContext('2d');
                        if (!overviewRuler || !overviewRulerContext || !scrollable) return null;
                        return {
                            inset: getComputedStyle(pane).backgroundColor,
                            overviewRulerBorderAlpha: overviewRulerContext.getImageData(
                                0,
                                Math.floor(overviewRuler.height / 2),
                                1,
                                1,
                            ).data[3],
                            scrollable: getComputedStyle(scrollable).backgroundColor,
                        };
                    }),
            (styles) =>
                styles.inset === 'rgb(48, 64, 80)' &&
                styles.overviewRulerBorderAlpha === 0 &&
                styles.scrollable === 'rgb(48, 64, 80)',
            { message: 'Terminal inset, overview ruler border, and scrollable element styles' },
        );
        expect(insetColors).toEqual({
            inset: 'rgb(48, 64, 80)',
            overviewRulerBorderAlpha: 0,
            scrollable: 'rgb(48, 64, 80)',
        });

        const terminalIds = (
            await pageRequest<{ terminals: Array<{ id: string }> }>(running.page, 'app.bootstrap')
        ).terminals.map((terminal) => terminal.id);
        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, terminalIds);
        await splitTerminalToRight(running.page, secondTerminalId);
        const terminalPanes = running.page.locator('.terminal-pane');
        await expect(terminalPanes).toHaveCount(2);

        /**
         * Reports `null` for a pane whose xterm has not re-attached its scrollbar yet, rather than throwing.
         * Playwright's `expect.poll` retries a _failed assertion_ but propagates an exception out of the callback
         * (`const value = await actual()` sits outside its try), so throwing here ends the poll below on its first
         * tick, turning "the resize has not settled" into a hard failure whenever the runner is loaded enough that
         * xterm rebuilds its scrollable element between the resize and the first sample.
         */
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
                    return screen && scrollbar
                        ? {
                              edgeGap: paneBounds.right - scrollbar.right,
                              textGutter: scrollbar.left - screen.right,
                          }
                        : null;
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
                        (pane) =>
                            pane !== null &&
                            Math.abs(pane.edgeGap) <= 1 &&
                            pane.textGutter >= 0 &&
                            pane.textGutter <= MAX_TEXT_GUTTER,
                    );
                })
                .toBe(true);
            // eslint-disable-next-line no-await-in-loop -- each viewport width must settle before the next resize.
            const geometry = await readGeometry();

            for (const [index, pane] of geometry.entries()) {
                // The poll above only converges once every pane reported geometry, so a gap here is a real defect.
                expect(pane, `viewport width ${width}px, pane ${index}`).not.toBeNull();
                expect(
                    Math.abs(pane?.edgeGap ?? NaN),
                    `viewport width ${width}px, pane ${index}`,
                ).toBeLessThanOrEqual(1);
                expect(
                    pane?.textGutter ?? NaN,
                    `viewport width ${width}px, pane ${index}`,
                ).toBeGreaterThanOrEqual(0);
                expect(
                    pane?.textGutter ?? NaN,
                    `viewport width ${width}px, pane ${index}`,
                ).toBeLessThanOrEqual(MAX_TEXT_GUTTER);
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
    const output = await createTerminalGlyphFixture(testDirectory);
    await execFileAsync('mkdir', ['-p', root]);

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

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [terminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
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
        const splitGrids = [
            await waitForStableTerminalGrid(running.page, terminalId),
            await waitForStableTerminalGrid(running.page, secondTerminalId),
        ];
        expect(splitGrids.every((grid) => /^\d+x\d+$/.test(grid))).toBe(true);
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

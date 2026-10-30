import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { E2EApp } from './support/electron-app.ts';
import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pressNewTerminal,
    selectedSessionId,
    sessionCard,
    splitTerminalToRight,
    typeTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';
import { openProjectNewSessionMenu } from './support/project-new-session-menu.ts';

function terminalSurface(page: Page, terminalId: string): Locator {
    return page.locator(`.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface`);
}

function terminalCommandStatus(page: Page, terminalId: string): Locator {
    return page.locator(
        `.terminal-pane[data-terminal-id="${terminalId}"] .terminal-command-status`,
    );
}

async function activeTerminalId(page: Page): Promise<string> {
    const terminalId = await page
        .locator('.work-tab.active[data-terminal-id]')
        .getAttribute('data-terminal-id');
    if (!terminalId) throw new Error('Active Terminal ID was not rendered');
    return terminalId;
}

/**
 * Resolves the runtime rgb() value of a theme token so decoration-color assertions track the active theme instead of a
 * hardcoded hex (`terminal-commands.ts` derives failed/succeeded gutter colors from `--danger` / `--success`).
 */
async function themeTokenColor(page: Page, token: '--danger' | '--success'): Promise<string> {
    return page.evaluate((tokenName) => {
        const probe = document.createElement('span');
        probe.style.color = getComputedStyle(document.documentElement)
            .getPropertyValue(tokenName)
            .trim();
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }, token);
}

async function expectCommandState(
    surface: Locator,
    expected: { commandCount: number; completedCount: number; lastExitStatus?: number },
): Promise<void> {
    await expect(surface).toHaveAttribute(
        'data-terminal-command-count',
        String(expected.commandCount),
    );
    await expect(surface).toHaveAttribute(
        'data-terminal-command-completed-count',
        String(expected.completedCount),
    );
    if (expected.lastExitStatus === undefined)
        await expect(surface).not.toHaveAttribute('data-terminal-command-last-exit-status', /.+/u);
    else
        await expect(surface).toHaveAttribute(
            'data-terminal-command-last-exit-status',
            String(expected.lastExitStatus),
        );
}

type TerminalCommandPhase = 'failed' | 'running' | 'succeeded';

interface TerminalDecorationPixelEvidence {
    background: [number, number, number];
    center: [number, number, number];
    centerChanged: boolean;
    changedPixels: number;
    computedColor: string;
    phase: TerminalCommandPhase;
}

async function terminalDecorationPixelEvidence(
    app: E2EApp,
    page: Page,
    terminalId: string,
    phase: TerminalCommandPhase,
): Promise<TerminalDecorationPixelEvidence> {
    const pane = page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`);
    const decoration = pane.locator(`[data-terminal-command-phase="${phase}"]`).last();
    await expect(decoration).toBeVisible();
    const geometry = await decoration.evaluate((element) => {
        const paneElement = element.closest('.terminal-pane');
        if (!paneElement) throw new Error('Terminal pane is unavailable');
        const paneBounds = paneElement.getBoundingClientRect();
        const decorationBounds = element.getBoundingClientRect();
        return {
            color: getComputedStyle(element).color,
            decoration: {
                height: decorationBounds.height,
                width: decorationBounds.width,
                x: decorationBounds.x - paneBounds.x,
                y: decorationBounds.y - paneBounds.y,
            },
            pane: { height: paneBounds.height, width: paneBounds.width },
            phase: (element as HTMLElement).dataset.terminalCommandPhase,
        };
    });
    const screenshot = await pane.screenshot();
    return app.evaluate(
        ({ nativeImage }, { geometry: measured, phase: expectedPhase, screenshotBase64 }) => {
            const image = nativeImage.createFromBuffer(Buffer.from(screenshotBase64, 'base64'));
            const size = image.getSize();
            const bitmap = image.toBitmap();
            const scaleX = size.width / measured.pane.width;
            const scaleY = size.height / measured.pane.height;
            const left = Math.max(0, Math.floor(measured.decoration.x * scaleX));
            const right = Math.min(
                size.width,
                Math.ceil((measured.decoration.x + measured.decoration.width) * scaleX),
            );
            const top = Math.max(0, Math.floor(measured.decoration.y * scaleY));
            const bottom = Math.min(
                size.height,
                Math.ceil((measured.decoration.y + measured.decoration.height) * scaleY),
            );
            const centerX = Math.min(size.width - 1, Math.floor((left + right) / 2));
            const centerY = Math.min(size.height - 1, Math.floor((top + bottom) / 2));
            const backgroundX = Math.max(0, left - Math.max(2, Math.round(2 * scaleX)));
            const pixel = (x: number, y: number): [number, number, number] => {
                const offset = (y * size.width + x) * 4;
                return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]];
            };
            const background = pixel(backgroundX, centerY);
            const isDifferentFromBackground = (sample: [number, number, number]): boolean =>
                Math.max(
                    Math.abs(sample[0] - background[0]),
                    Math.abs(sample[1] - background[1]),
                    Math.abs(sample[2] - background[2]),
                ) > 8;
            let changedPixels = 0;
            for (let y = top; y < bottom; y += 1) {
                for (let x = left; x < right; x += 1) {
                    if (isDifferentFromBackground(pixel(x, y))) changedPixels += 1;
                }
            }
            if (measured.phase !== expectedPhase)
                throw new Error(`Expected ${expectedPhase} decoration, received ${measured.phase}`);
            const center = pixel(centerX, centerY);
            return {
                background,
                center,
                centerChanged: isDifferentFromBackground(center),
                changedPixels,
                computedColor: measured.color,
                phase: expectedPhase,
            };
        },
        { geometry, phase, screenshotBase64: screenshot.toString('base64') },
    );
}

async function terminalLayoutEvidence(surface: Locator): Promise<{
    canvasGeometry: Array<{
        className: string;
        height: number;
        width: number;
        x: number;
        y: number;
    }>;
    grid: string | undefined;
    renderer: string | undefined;
    screen: { height: number; width: number; x: number; y: number };
    scrollTop: number;
}> {
    return surface.evaluate((element) => {
        const screen = element.querySelector('.xterm-screen');
        const viewport = element.querySelector('.xterm-viewport');
        if (!screen || !viewport) throw new Error('Terminal layout is unavailable');
        const surfaceBounds = element.getBoundingClientRect();
        const relativeGeometry = (target: Element) => {
            const bounds = target.getBoundingClientRect();
            return {
                className: (target as HTMLElement).className,
                height: bounds.height,
                width: bounds.width,
                x: bounds.x - surfaceBounds.x,
                y: bounds.y - surfaceBounds.y,
            };
        };
        const screenGeometry = relativeGeometry(screen);
        return {
            canvasGeometry: [...element.querySelectorAll(':scope .xterm canvas')].map(
                relativeGeometry,
            ),
            grid: (element as HTMLElement).dataset.terminalGrid,
            renderer: (element as HTMLElement).dataset.terminalRenderer,
            screen: {
                height: screenGeometry.height,
                width: screenGeometry.width,
                x: screenGeometry.x,
                y: screenGeometry.y,
            },
            scrollTop: viewport.scrollTop,
        };
    });
}

test('command gutter paints running, succeeded, and failed phases without moving the grid', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-command-pixels-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        env: { SHELL: '/bin/zsh' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const terminalId = await activeTerminalId(running.page);
        const surface = terminalSurface(running.page, terminalId);
        await expect(surface).toHaveAttribute('data-terminal-grid', /^\d+x\d+$/u);
        await expect(surface).toHaveAttribute('data-terminal-renderer', /^(?:dom|webgl)$/u);
        const layoutBefore = await terminalLayoutEvidence(surface);

        await typeTerminal(running.page, 'sleep 60', terminalId);
        await expectCommandState(surface, { commandCount: 1, completedCount: 0 });
        const runningPixels = await terminalDecorationPixelEvidence(
            running.app,
            running.page,
            terminalId,
            'running',
        );
        expect(runningPixels.changedPixels, JSON.stringify(runningPixels)).toBeGreaterThan(16);
        expect(runningPixels.centerChanged, JSON.stringify(runningPixels)).toBe(false);

        await running.page
            .locator(`.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`)
            .press('Control+C');
        await expect(surface.locator('[data-terminal-command-phase="failed"]')).toHaveCount(1);
        const failedPixels = await terminalDecorationPixelEvidence(
            running.app,
            running.page,
            terminalId,
            'failed',
        );
        expect(failedPixels.changedPixels, JSON.stringify(failedPixels)).toBeGreaterThan(16);
        expect(failedPixels.computedColor).toBe(await themeTokenColor(running.page, '--danger'));

        await typeTerminal(running.page, 'true', terminalId);
        await expectCommandState(surface, {
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 0,
        });
        const succeededPixels = await terminalDecorationPixelEvidence(
            running.app,
            running.page,
            terminalId,
            'succeeded',
        );
        expect(succeededPixels.changedPixels, JSON.stringify(succeededPixels)).toBeGreaterThan(32);
        expect(succeededPixels.centerChanged, JSON.stringify(succeededPixels)).toBe(true);
        expect(succeededPixels.computedColor).toBe(
            await themeTokenColor(running.page, '--success'),
        );

        expect(await terminalLayoutEvidence(surface)).toEqual(layoutBefore);
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${terminalId}"] .xterm-helper-textarea`,
            ),
        ).toBeFocused();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('zsh command boundaries survive scrollback, split resize, Session switches, and reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commands-zsh-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        env: { SHELL: '/bin/zsh' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        const firstTerminalId = await activeTerminalId(running.page);
        const firstSurface = terminalSurface(running.page, firstTerminalId);
        await expectCommandState(firstSurface, { commandCount: 0, completedCount: 0 });

        await typeTerminal(
            running.page,
            String.raw`for value in {1..120}; do printf 'COMMAND_NAV_%03d\n' "$value"; done`,
        );
        await expectCommandState(firstSurface, {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await expect(terminalCommandStatus(running.page, firstTerminalId)).toHaveText(
            'Command completed successfully.',
        );
        await typeTerminal(running.page, 'false');
        await expectCommandState(firstSurface, {
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 1,
        });
        await expect(terminalCommandStatus(running.page, firstTerminalId)).toHaveText(
            'Command failed with exit status 1.',
        );
        await expect(firstSurface.locator('[data-terminal-command-phase="failed"]')).toHaveCount(1);
        /**
         * The decoration gutter must not surface xterm.css's hardcoded black viewport background as a visible strip;
         * the terminal container owns the background color.
         */
        expect(
            await firstSurface.evaluate((element) => {
                const xterm = element.querySelector('.xterm')!;
                const viewport = xterm.querySelector('.xterm-viewport')!;
                return {
                    paddingLeft: getComputedStyle(xterm).paddingLeft,
                    viewportBackground: getComputedStyle(viewport).backgroundColor,
                };
            }),
        ).toEqual({ paddingLeft: '20px', viewportBackground: 'rgba(0, 0, 0, 0)' });

        const visibleRows = firstSurface.locator('.xterm-rows');
        await running.page.keyboard.press('Meta+Shift+ArrowUp');
        await running.page.keyboard.press('Meta+Shift+ArrowUp');
        await expect(visibleRows).toContainText('COMMAND_NAV_001');
        await running.page.keyboard.press('Meta+Shift+ArrowDown');
        await expect(visibleRows).toContainText('COMMAND_NAV_120');

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [firstTerminalId]);
        const secondSurface = terminalSurface(running.page, secondTerminalId);
        await expect(secondSurface).toHaveAttribute('data-terminal-attached', 'true');
        await expectCommandState(secondSurface, { commandCount: 0, completedCount: 0 });
        /**
         * A new Terminal can exist in Server state and the tab bar before React switches the active pane. Splitting at
         * that point preserves the first Terminal's mounted tracker, so its two observed commands correctly remain
         * visible. Wait for its actual unmount before asserting that a later remount starts with no OSC history.
         */
        await expect(firstSurface).toHaveCount(0);
        await splitTerminalToRight(running.page, secondTerminalId);
        await expectCommandState(secondSurface, { commandCount: 0, completedCount: 0 });
        await expect(terminalSurface(running.page, firstTerminalId)).toBeVisible();
        /**
         * A parsed attach snapshot cannot prove historical OSC boundaries. The remounted tracker must start empty
         * instead of fabricating or duplicating status from visible text.
         */
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 0,
            completedCount: 0,
        });
        await running.page
            .locator(`.work-tab[data-terminal-id="${firstTerminalId}"] [role="tab"]`)
            .click();
        await typeTerminal(running.page, 'true # AFTER_SPLIT', firstTerminalId);
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await expect(terminalCommandStatus(running.page, firstTerminalId)).toHaveText(
            'Command completed successfully.',
        );
        const splitter = running.page.getByRole('separator', { name: /Resize .* split/u });
        const splitterBox = await splitter.boundingBox();
        if (!splitterBox) throw new Error('Terminal split handle was not rendered');
        await running.page.mouse.move(
            splitterBox.x + splitterBox.width / 2,
            splitterBox.y + splitterBox.height / 2,
        );
        await running.page.mouse.down();
        await running.page.mouse.move(splitterBox.x + 60, splitterBox.y);
        await running.page.mouse.up();
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });

        await createAdditionalShellSession(running.page);
        await sessionCard(running.page, firstSessionId).click();
        await expect(sessionCard(running.page, firstSessionId)).toHaveClass(/active/u);
        /**
         * Unlike a split or a reload, leaving and re-entering a recently used Session does not remount the Terminal:
         * keep-alive holds its pane, so the tracker never stopped reading the live OSC stream and has nothing to
         * rebuild. Resetting here would mean the user lost boundaries they had watched arrive.
         */
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await running.page
            .locator(`.work-tab[data-terminal-id="${firstTerminalId}"] [role="tab"]`)
            .click();
        await typeTerminal(running.page, 'true # AFTER_SESSION_SWITCH', firstTerminalId);
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 0,
        });

        await running.page.evaluate(() => {
            document.documentElement.dataset.terminalCommandPreReload = 'true';
        });
        await running.page.reload();
        await expect(running.page.locator('html')).not.toHaveAttribute(
            'data-terminal-command-pre-reload',
            'true',
        );
        await expect(terminalSurface(running.page, firstTerminalId)).toHaveAttribute(
            'data-terminal-attached',
            'true',
        );
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 0,
            completedCount: 0,
        });
        await typeTerminal(running.page, 'true # AFTER_RENDERER_RELOAD', firstTerminalId);
        await expectCommandState(terminalSurface(running.page, firstTerminalId), {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('bash reports successful and failed command status without retaining command text', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commands-bash-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        env: { SHELL: '/bin/bash' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const terminalId = await activeTerminalId(running.page);
        const surface = terminalSurface(running.page, terminalId);
        await expectCommandState(surface, { commandCount: 0, completedCount: 0 });
        await typeTerminal(running.page, 'true # COMMAND_BODY_PRIVATE');
        await expectCommandState(surface, {
            commandCount: 1,
            completedCount: 1,
            lastExitStatus: 0,
        });
        await expect(terminalCommandStatus(running.page, terminalId)).toHaveText(
            'Command completed successfully.',
        );
        await typeTerminal(running.page, 'false');
        await expectCommandState(surface, {
            commandCount: 2,
            completedCount: 2,
            lastExitStatus: 1,
        });
        await expect(terminalCommandStatus(running.page, terminalId)).toHaveText(
            'Command failed with exit status 1.',
        );
        await expect(surface.locator('[data-terminal-command-phase="failed"]')).toHaveCount(1);
        const commandMetadata = await surface.evaluate((element) => ({
            decorations: [...element.querySelectorAll('.terminal-command-decoration')].map(
                (decoration) => ({ ...(decoration as HTMLElement).dataset }),
            ),
            surface: { ...(element as HTMLElement).dataset },
        }));
        expect(JSON.stringify(commandMetadata)).not.toContain('COMMAND_BODY_PRIVATE');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('unsupported shells and Agent Terminals remain usable without inferred boundaries', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-commands-fallback-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { startupOutput: 'COMMAND_AGENT_READY\r\n' } },
    });

    const running = await launchCaxri({
        agentMode,
        env: { SHELL: '/bin/sh' },
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const shellSurface = terminalSurface(running.page, await activeTerminalId(running.page));
        await typeTerminal(running.page, String.raw`printf 'UNSUPPORTED_SHELL_READY\n'`);
        await expect(shellSurface.locator('.xterm-rows')).toContainText('UNSUPPORTED_SHELL_READY');
        await expectCommandState(shellSurface, { commandCount: 0, completedCount: 0 });
        await expect(
            terminalCommandStatus(running.page, await activeTerminalId(running.page)),
        ).toBeEmpty();

        const shellSessionId = await selectedSessionId(running.page);
        const shellTerminalId = await activeTerminalId(running.page);
        await openProjectNewSessionMenu(running.page);
        await chooseTerminalFromCreateMenu(running.page, 'Codex');
        await expect.poll(() => selectedSessionId(running.page)).not.toBe(shellSessionId);
        const agentTerminalId = await waitForNewTerminalId(running.page, [shellTerminalId]);
        const agentSurface = terminalSurface(running.page, agentTerminalId);
        await expect(agentSurface.locator('.xterm-rows')).toContainText('COMMAND_AGENT_READY');
        await expectCommandState(agentSurface, { commandCount: 0, completedCount: 0 });
        await expect(agentSurface.locator('.terminal-command-decoration')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from './fixtures.ts';

import { createShellSession, launchCaxri, pageRequest, typeTerminal } from './helpers.ts';

type GpuPreference = 'Auto' | 'On' | 'Off';

async function applyGpuPreference(page: Page, preference: GpuPreference): Promise<void> {
    await page.keyboard.press('Meta+,');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Terminal GPU acceleration').click();
    await page.getByRole('option', { name: preference, exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect
        .poll(async () => {
            const settings = await pageRequest<{
                value: { 'terminal.gpuAcceleration': string };
            }>(page, 'settings.get');
            return settings.value['terminal.gpuAcceleration'];
        })
        .toBe(preference.toLowerCase());
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

test('WebGL modes hot-switch, redraw on restore, and fail over without restarting the Terminal', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-webgl-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    const running = await launchCaxri({
        gpuMode: 'enabled',
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const pane = running.page.locator('.terminal-pane');
        const surface = pane.locator('.terminal-surface');
        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'disabled');

        await applyGpuPreference(running.page, 'Auto');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'active');

        const redrawsBeforeRestore = Number(
            (await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0,
        );
        await running.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect
            .poll(async () =>
                Number((await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0),
            )
            .toBeGreaterThan(redrawsBeforeRestore);

        await applyGpuPreference(running.page, 'Off');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'disabled');

        await applyGpuPreference(running.page, 'On');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        const runningBeforeLoss = await pageRequest<number>(running.page, 'terminal.runningCount');
        await typeTerminal(
            running.page,
            "printf 'WEBGL_CONTINUITY_界_😀\\n'; for value in {1..160}; do printf 'atlas-%03d ┃  █\\n' \"$value\"; done",
        );

        const contextWasLost = await surface.evaluate((element) => {
            for (const canvas of element.querySelectorAll('canvas')) {
                const context = canvas.getContext('webgl2');
                const extension = context?.getExtension('WEBGL_lose_context');
                if (!extension) continue;
                extension.loseContext();
                return true;
            }
            return false;
        });
        expect(contextWasLost).toBe(true);
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom', { timeout: 8_000 });
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'context-loss');
        await expect(surface).toHaveAttribute('data-terminal-webgl-context-losses', '1');
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
        await expect
            .poll(() => pageRequest<number>(running.page, 'terminal.runningCount'))
            .toBe(runningBeforeLoss);
        await expect(running.page.locator('.xterm-rows')).toContainText('atlas-160');

        await typeTerminal(running.page, "printf 'AFTER_WEBGL_FALLBACK\\n'");
        await expect(running.page.locator('.xterm-rows')).toContainText('AFTER_WEBGL_FALLBACK');
        await expect(
            running.page.locator(`.work-tab[data-terminal-id="${terminalId}"] .process-running`),
        ).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

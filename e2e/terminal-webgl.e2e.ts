import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    revealSettingsSection,
    splitTerminalToRight,
    typeTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';

type GpuPreference = 'Auto' | 'On' | 'Off';

async function applyGpuPreference(page: Page, preference: GpuPreference): Promise<void> {
    await page.keyboard.press('Meta+,');
    const dialog = page.getByRole('dialog');
    await revealSettingsSection(dialog, 'Terminal');
    await dialog.getByRole('combobox', { name: 'GPU acceleration' }).click();
    await page.getByRole('option', { name: preference, exact: true }).click();
    /**
     * Settings apply immediately (there is no Apply button); the observable invariant is the Runtime actually
     * persisting the change, not an arbitrary wait.
     */
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

test('WebGL modes hot-switch and every Terminal recovers from one GPU process loss', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'gpu.process_gone', code: 'GPU_PROCESS_GONE', count: 1 },
    ]);
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
        let terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'disabled');

        await applyGpuPreference(running.page, 'Auto');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'active');

        const redrawsBeforeRestore = Number(
            (await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0,
        );
        await running.page.evaluate(() => dispatchEvent(new Event('focus')));
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
        const completedBeforeScrollback = Number(
            (await surface.getAttribute('data-terminal-command-completed-count')) ?? 0,
        );
        await typeTerminal(running.page, String.raw`printf 'FIRST_PANE_SCROLLBACK\n'`);
        await expect(surface).toHaveAttribute(
            'data-terminal-command-completed-count',
            String(completedBeforeScrollback + 1),
        );
        terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered after mode changes');

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [terminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        const surfaces = running.page.locator('.terminal-surface');
        const firstPane = running.page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`);
        const firstRows = firstPane.locator('.xterm-rows');
        const secondRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
        );
        await expect(surfaces).toHaveCount(2);
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer', 'webgl');
        const runningBeforeLoss = await pageRequest<number>(running.page, 'terminal.runningCount');
        await typeTerminal(
            running.page,
            String.raw`printf 'WEBGL_CONTINUITY_界_😀\n'; for value in {1..160}; do printf 'atlas-%03d ┃  █\n' "$value"; done`,
        );

        const focusedTerminalId = await running.page
            .locator('.terminal-pane:has(.xterm-helper-textarea:focus)')
            .getAttribute('data-terminal-id');
        const incident = await pageRequest<{ correlationId: string }>(
            running.page,
            'gpu.testInjectContextLoss',
        );
        expect(incident.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
        /**
         * Main and both mounted Terminals observe the same correlated GPU incident. The coordinator must collapse those
         * three signals into one transient, actionable notification before the durable renderer state is checked.
         */
        const recoveryNotification = running.page.getByText(
            'A GPU process crash interrupted rendering. Caxri switched affected Terminals to software rendering.',
            { exact: true },
        );
        await expect(recoveryNotification).toHaveCount(1, { timeout: 8_000 });
        await expect(
            running.page.getByRole('button', { name: 'Restart in GPU Safe Mode' }),
        ).toHaveCount(1);
        await expect(recoveryNotification).toHaveCount(0, { timeout: 6_000 });
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer', 'dom', {
            timeout: 8_000,
        });
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer', 'dom', {
            timeout: 8_000,
        });
        await expect(surfaces.nth(0)).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss',
        );
        await expect(surfaces.nth(1)).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss',
        );
        await expect(firstPane).toHaveAttribute('data-terminal-id', terminalId);
        await expect(
            running.page.locator(`.terminal-pane[data-terminal-id="${secondTerminalId}"]`),
        ).toBeAttached();
        expect(
            await running.page
                .locator('.terminal-pane:has(.xterm-helper-textarea:focus)')
                .getAttribute('data-terminal-id'),
        ).toBe(focusedTerminalId);
        await expect
            .poll(() => pageRequest<number>(running.page, 'terminal.runningCount'))
            .toBe(runningBeforeLoss);
        await expect(secondRows).toContainText('atlas-160');
        await expect(firstRows).toContainText('FIRST_PANE_SCROLLBACK');

        await typeTerminal(running.page, String.raw`printf 'AFTER_WEBGL_FALLBACK\n'`);
        await expect(secondRows).toContainText('AFTER_WEBGL_FALLBACK');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('two context losses activate reversible GPU Safe Mode on the next launch', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'gpu.process_gone', code: 'GPU_PROCESS_GONE', count: 4 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-gpu-safe-mode-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    let running = await launchCaxri({
        quitDecisionOnClose: 'keep-running',
        gpuMode: 'enabled',
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: { hardwareAcceleration: boolean };
                }>(running.page, 'argv.get');
                return result.value.hardwareAcceleration;
            })
            .toBe(false);

        await running.app.close();
        running = await launchCaxri({
            quitDecisionOnClose: 'keep-running',
            gpuMode: 'enabled',
            userDataDir: userData,
            testRootPath: root,
        });
        await expect(
            running.page.getByText(
                'Caxri disabled hardware acceleration after repeated GPU crashes.',
                { exact: true },
            ),
        ).toBeVisible();
        await typeTerminal(running.page, String.raw`printf 'SAFE_MODE_TERMINAL_OK\n'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('SAFE_MODE_TERMINAL_OK');
        await running.page.getByRole('button', { name: 'Open Settings' }).click();
        const dialog = running.page.getByRole('dialog');
        const acceleration = dialog.getByRole('switch', { name: 'Hardware acceleration' });
        await expect(acceleration).not.toBeChecked();
        await acceleration.click();
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: { hardwareAcceleration: boolean };
                }>(running.page, 'argv.get');
                return result.value.hardwareAcceleration;
            })
            .toBe(true);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();

        await running.app.close();
        running = await launchCaxri({
            gpuMode: 'enabled',
            userDataDir: userData,
            testRootPath: root,
        });
        await expect(
            running.page.getByText(
                'Caxri disabled hardware acceleration after repeated GPU crashes.',
                { exact: true },
            ),
        ).toHaveCount(0);
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        const afterOne = await pageRequest<{ value: { hardwareAcceleration: boolean } }>(
            running.page,
            'argv.get',
        );
        expect(afterOne.value.hardwareAcceleration).toBe(true);
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: { hardwareAcceleration: boolean };
                }>(running.page, 'argv.get');
                return result.value.hardwareAcceleration;
            })
            .toBe(false);

        const records = (await readFile(join(userData, 'logs', 'desktop.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> });
        expect(
            records.some(
                (record) =>
                    record.event === 'gpu.safe_mode' &&
                    record.fields?.code === 'GPU_SAFE_MODE_BOOT' &&
                    record.fields.hardwareAccelerationEnabled === false,
            ),
        ).toBe(true);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

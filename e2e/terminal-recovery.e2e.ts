import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createProjectSession, launchCaxri, pageRequest } from './helpers.ts';

async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator('.xterm-helper-textarea').last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

test('normal exit stays neutral and restart preserves one durable Terminal', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-recovery-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page, 'shell');
        const pane = running.page.locator('.terminal-pane');
        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        const tabCount = await running.page.locator('.work-tab[data-terminal-id]').count();

        await typeTerminal(running.page, "printf 'FINAL_OUTPUT_IS_VISIBLE\\n'; exit");
        const stopped = running.page.locator('[data-terminal-exit-state="stopped"]');
        await expect(stopped).toContainText('Process exited normally');
        await expect(stopped).toHaveClass(/terminal-recovery-neutral/);
        await expect(running.page.locator('.xterm-rows')).toContainText('FINAL_OUTPUT_IS_VISIBLE');

        const [surfaceBox, recoveryBox] = await Promise.all([
            running.page.locator('.terminal-surface').boundingBox(),
            stopped.boundingBox(),
        ]);
        if (!surfaceBox || !recoveryBox) throw new Error('Terminal recovery layout is missing');
        expect(surfaceBox.y + surfaceBox.height).toBeLessThanOrEqual(recoveryBox.y + 1);

        const restart = stopped.getByRole('button', { name: 'Restart Terminal' });
        await restart.focus();
        await running.page.keyboard.press('Enter');
        await expect(stopped).toHaveCount(0);
        await expect(running.page.locator('.process-running')).toBeVisible();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(tabCount);
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
        await expect.poll(() => pageRequest<number>(running.page, 'terminal.runningCount')).toBe(1);

        await typeTerminal(running.page, 'kill -9 $$');
        const dead = running.page.locator('[data-terminal-exit-state="dead"]');
        await expect(dead).toContainText('Terminal stopped unexpectedly');
        await expect(dead).toHaveClass(/terminal-recovery-danger/);

        await running.page.keyboard.press('Meta+Shift+R');
        await expect(dead).toHaveCount(0);
        await expect(running.page.locator('.process-running')).toBeVisible();
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('startup failure uses a compact danger status without covering output', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-failed-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: '/caxri-e2e-missing', SHELL: '/usr/bin/false' },
    });
    try {
        await createProjectSession(running.page, 'codex');
        const failed = running.page.locator('[data-terminal-exit-state="failed"]');
        await expect(failed).toContainText('Terminal failed to start');
        await expect(failed).toHaveClass(/terminal-recovery-danger/);
        await expect(failed.getByRole('button', { name: 'Restart Terminal' })).toBeVisible();

        const [surfaceBox, recoveryBox] = await Promise.all([
            running.page.locator('.terminal-surface').boundingBox(),
            failed.boundingBox(),
        ]);
        if (!surfaceBox || !recoveryBox) throw new Error('Terminal failure layout is missing');
        expect(surfaceBox.y + surfaceBox.height).toBeLessThanOrEqual(recoveryBox.y + 1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

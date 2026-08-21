import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    selectedSessionId,
} from './support/helpers.ts';

async function quickSwitch(page: Parameters<typeof selectedSessionId>[0]): Promise<void> {
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
}

test('Session MRU switching cycles, respects editable focus, and persists across restart', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-mru-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const launchOptions = { userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(launchOptions);
    try {
        await createShellSession(running.page);
        const sessionA = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const sessionB = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const sessionC = await selectedSessionId(running.page);

        const terminalInput = running.page.locator('.xterm-helper-textarea').last();
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await running.page.keyboard.down('Control');
        await running.page.keyboard.down('Alt');
        await running.page.keyboard.press('Tab');
        const switcher = running.page.getByRole('listbox', { name: 'Recently used Sessions' });
        await expect(switcher).toBeVisible();
        await expect(switcher.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true');
        await expect(switcher.getByRole('option').nth(0)).toHaveAttribute(
            'data-session-id',
            sessionB,
        );

        await running.page.keyboard.press('Tab');
        await expect(switcher.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
        await expect(switcher.getByRole('option').nth(1)).toHaveAttribute(
            'data-session-id',
            sessionA,
        );
        await running.page.keyboard.press('Shift+Tab');
        await expect(switcher.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true');
        await running.page.keyboard.up('Alt');
        await running.page.keyboard.up('Control');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
        await expect(switcher).toBeHidden();

        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionC);
        await expect(switcher).toBeHidden();
        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);

        await running.page.keyboard.down('Control');
        await running.page.keyboard.down('Alt');
        await running.page.keyboard.press('Tab');
        await expect(switcher).toBeVisible();
        await running.page.keyboard.press('Escape');
        await running.page.keyboard.up('Alt');
        await running.page.keyboard.up('Control');
        await expect(switcher).toBeHidden();
        expect(await selectedSessionId(running.page)).toBe(sessionB);

        await running.app.close();
        running = await launchCaxri(launchOptions);
        expect(await selectedSessionId(running.page)).toBe(sessionB);
        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionC);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '../src/shared/node/exec.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
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
        await expect(switcher).toHaveAttribute(
            'aria-activedescendant',
            `session-mru-option-${sessionB}`,
        );
        await expect(running.page.getByRole('status').filter({ hasText: '1 of 2' })).toBeAttached();

        await running.page.keyboard.press('Tab');
        await expect(switcher.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
        await expect(switcher.getByRole('option').nth(1)).toHaveAttribute(
            'data-session-id',
            sessionA,
        );
        await expect(switcher).toHaveAttribute(
            'aria-activedescendant',
            `session-mru-option-${sessionA}`,
        );
        await expect(running.page.getByRole('status').filter({ hasText: '2 of 2' })).toBeAttached();
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

        // Make A the durable previous Session while ending on B. Creation-order fallback would
        // still choose C after restart, so the final assertion proves persisted MRU state.
        await running.page.keyboard.down('Control');
        await running.page.keyboard.down('Alt');
        await running.page.keyboard.press('Tab');
        await running.page.keyboard.press('Tab');
        await running.page.keyboard.up('Alt');
        await running.page.keyboard.up('Control');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);

        await running.app.close();
        running = await launchCaxri(launchOptions);
        expect(await selectedSessionId(running.page)).toBe(sessionB);
        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session MRU custom binding ignores ordinary and composing input and commits on blur', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-mru-custom-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const sessionA = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const sessionB = await selectedSessionId(running.page);
        const keybindings = await pageRequest<{
            value: Array<{ command: string; key: string }>;
        }>(running.page, 'keybindings.get');
        await pageRequest(running.page, 'keybindings.update', {
            source: JSON.stringify(
                keybindings.value.map((binding) =>
                    binding.command === 'session.switchMru'
                        ? { ...binding, key: 'ctrl+alt+m' }
                        : binding,
                ),
                null,
                2,
            ),
        });

        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        await dialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        await dialog.getByLabel('Search keyboard shortcuts').fill('session.switchMru');
        await expect(dialog.locator('[data-shortcut="ctrl+alt+m"]')).toBeVisible();
        await running.page.keyboard.press('Escape');

        const terminalInput = running.page.locator('.xterm-helper-textarea').last();
        await terminalInput.focus();
        await terminalInput.pressSequentially('mru_ordinary_probe');
        await expect(
            running.page.locator('.terminal-pane:has(.xterm-helper-textarea:focus) .xterm-rows'),
        ).toContainText('mru_ordinary_probe');
        await terminalInput.press('Control+u');
        expect(await selectedSessionId(running.page)).toBe(sessionB);
        const composingEventWasNotCanceled = await terminalInput.evaluate((target) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    altKey: true,
                    bubbles: true,
                    cancelable: true,
                    code: 'KeyM',
                    ctrlKey: true,
                    isComposing: true,
                    key: 'm',
                }),
            ),
        );
        expect(composingEventWasNotCanceled).toBe(true);
        expect(await selectedSessionId(running.page)).toBe(sessionB);
        await expect(
            running.page.getByRole('listbox', { name: 'Recently used Sessions' }),
        ).toHaveCount(0);

        await running.page.keyboard.down('Control');
        await running.page.keyboard.down('Alt');
        await running.page.keyboard.press('m');
        await expect(
            running.page.getByRole('listbox', { name: 'Recently used Sessions' }),
        ).toBeVisible();
        await running.page.evaluate(() => dispatchEvent(new Event('blur')));
        await running.page.keyboard.up('Alt');
        await running.page.keyboard.up('Control');
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

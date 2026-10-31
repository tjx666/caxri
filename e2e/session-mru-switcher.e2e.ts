import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
    VISIBLE_TERMINAL_INPUT,
} from './support/helpers.ts';
import { openSettingsPage, openSettingsSection } from './support/settings.ts';

type Page = Parameters<typeof selectedSessionId>[0];

/**
 * Holds the default `Ctrl+Alt+Tab` Session MRU modifiers; the switcher stays open until they are released.
 */
async function holdMruModifiers(page: Page): Promise<void> {
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
}

async function releaseMruModifiers(page: Page): Promise<void> {
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
}

async function quickSwitch(page: Page): Promise<void> {
    await holdMruModifiers(page);
    await page.keyboard.press('Tab');
    await releaseMruModifiers(page);
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

        const activeWorkTab = running.page.locator(
            `${VISIBLE_SESSION} .workbench-pane.active .work-tab.active`,
        );
        const firstTerminalId = await activeWorkTab.getAttribute('data-terminal-id');
        expect(firstTerminalId).toBeTruthy();
        await running.page.keyboard.press('Meta+T');
        /**
         * Terminal creation crosses Renderer and Server boundaries. Wait for the active tab identity to advance before
         * capturing it; under CI load the old active tab can remain observable briefly after the shortcut resolves.
         */
        await expect(activeWorkTab).not.toHaveAttribute('data-terminal-id', firstTerminalId!);
        const secondTerminalId = await activeWorkTab.getAttribute('data-terminal-id');
        expect(secondTerminalId).toBeTruthy();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        const secondTerminalInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-helper-textarea`,
        );
        await secondTerminalInput.focus();
        await expect(secondTerminalInput).toBeFocused();
        await running.page.keyboard.press('Control+Tab');
        await expect(activeWorkTab).not.toHaveAttribute('data-terminal-id', secondTerminalId!);
        expect(await selectedSessionId(running.page)).toBe(sessionC);
        await running.page.keyboard.press('Control+Shift+Tab');
        await expect(activeWorkTab).toHaveAttribute('data-terminal-id', secondTerminalId!);
        expect(await selectedSessionId(running.page)).toBe(sessionC);

        const terminalInput = running.page.locator(VISIBLE_TERMINAL_INPUT).last();
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();
        await holdMruModifiers(running.page);
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
        await releaseMruModifiers(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
        await expect(switcher).toBeHidden();

        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionC);
        await expect(switcher).toBeHidden();
        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);

        await holdMruModifiers(running.page);
        await running.page.keyboard.press('Tab');
        await expect(switcher).toBeVisible();
        await running.page.keyboard.press('Escape');
        await releaseMruModifiers(running.page);
        await expect(switcher).toBeHidden();
        expect(await selectedSessionId(running.page)).toBe(sessionB);

        /**
         * The switcher is a modal moment: a click aimed at a PrimarySidebar Session must hit its scrim instead. Letting
         * it through would switch the Session immediately and then commit a second, stale one when the chord is
         * released. `force` is what makes this a regression test: Playwright would otherwise refuse the click precisely
         * because the scrim covers the card, and a scrim that stopped taking pointer events would make the click
         * succeed.
         */
        await holdMruModifiers(running.page);
        await running.page.keyboard.press('Tab');
        await expect(switcher).toBeVisible();
        await sessionCard(running.page, sessionC).click({ force: true });
        await expect(switcher).toBeHidden();
        await releaseMruModifiers(running.page);
        expect(await selectedSessionId(running.page)).toBe(sessionB);

        // Make A the durable previous Session while ending on B. Creation-order fallback would
        // still choose C after restart, so the final assertion proves persisted MRU state.
        await holdMruModifiers(running.page);
        await running.page.keyboard.press('Tab');
        await running.page.keyboard.press('Tab');
        await releaseMruModifiers(running.page);
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

test('Session MRU default reaches through Monaco and form focus without intercepting composition', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-mru-focus-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(join(root, 'README.md'), '# Session MRU focus fixture\n', 'utf8');
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const sessionA = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        const sessionB = await selectedSessionId(running.page);
        const keybindings = await pageRequest<{
            value: Array<{ command: string; key: string }>;
        }>(running.page, 'keybindings.get');
        expect(
            keybindings.value.filter((binding) => binding.command === 'session.switchMru'),
        ).toEqual([{ key: 'ctrl+alt+tab', command: 'session.switchMru' }]);
        // `Cmd+Backquote` belongs to the macOS window cycle, so no default may claim it.
        expect(keybindings.value.filter((binding) => binding.key === 'cmd+`')).toEqual([]);

        await running.page.keyboard.press('Meta+P');
        const pathDialog = running.page.getByRole('dialog');
        const pathInput = pathDialog.getByRole('combobox', { name: 'File path' });
        await pathInput.fill('readme');
        await expect(pathInput).toHaveAttribute('aria-busy', 'false');
        await pathInput.press('Enter');
        // No compensating click: opening a file from the picker is expected to put the keyboard in the Editor itself.
        const editor = running.page.locator('.monaco-editor').first();
        await expect
            .poll(() => editor.evaluate((element) => element.contains(document.activeElement)))
            .toBe(true);

        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);

        /**
         * Server selection can settle before the Renderer replaces the previous Session's search subscription. Wait for
         * the rendered selection before sending a command that belongs to the new Session.
         */
        await expect(
            running.page.locator(
                `.session-card[aria-selected="true"][data-session-id="${sessionA}"]`,
            ),
        ).toBeVisible();
        await running.page.keyboard.press('Meta+Shift+F');
        // Content is the default mode, so the shortcut lands on the content input.
        const searchInput = running.page.getByRole('combobox', {
            name: 'Search Project contents',
        });
        await expect(searchInput).toBeFocused();
        const composingEventWasNotCanceled = await searchInput.evaluate((target) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    altKey: true,
                    bubbles: true,
                    cancelable: true,
                    code: 'Tab',
                    ctrlKey: true,
                    isComposing: true,
                    key: 'Tab',
                }),
            ),
        );
        expect(composingEventWasNotCanceled).toBe(true);
        expect(await selectedSessionId(running.page)).toBe(sessionA);
        await expect(
            running.page.getByRole('listbox', { name: 'Recently used Sessions' }),
        ).toHaveCount(0);

        // Search Files is a modal overlay now, and a modal holds the keyboard until it is dismissed.
        await running.page.keyboard.press('Escape');
        await expect(searchInput).toHaveCount(0);
        await quickSwitch(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionB);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Session MRU starts in reverse with Ctrl+Alt+Shift+Tab and commits only on modifier release', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-mru-reverse-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const sessionA = await selectedSessionId(running.page);
        await createAdditionalShellSession(running.page);
        await createAdditionalShellSession(running.page);

        await holdMruModifiers(running.page);
        await running.page.keyboard.down('Shift');
        await running.page.keyboard.press('Tab');
        const switcher = running.page.getByRole('listbox', { name: 'Recently used Sessions' });
        await expect(switcher).toBeVisible();
        await expect(switcher.getByRole('option').nth(1)).toHaveAttribute(
            'data-session-id',
            sessionA,
        );
        await expect(switcher.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');

        await running.page.keyboard.up('Shift');
        await expect(switcher).toBeVisible();
        await releaseMruModifiers(running.page);
        await expect.poll(() => selectedSessionId(running.page)).toBe(sessionA);
        await expect(switcher).toBeHidden();
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

        const settingsTab = await openSettingsPage(running.page);
        await openSettingsSection(settingsTab, 'Keybindings');
        await settingsTab.getByLabel('Search keyboard shortcuts').fill('session.switchMru');
        await expect(settingsTab.locator('[data-shortcut="ctrl+alt+m"]')).toBeVisible();
        // The Settings page covers the Workbench (issue caxri#2369): `Cmd+W` closes it so the
        // Terminal below is visible again for `terminalInput.focus()`.
        await running.page.keyboard.press('Meta+w');

        const terminalInput = running.page.locator(VISIBLE_TERMINAL_INPUT).last();
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

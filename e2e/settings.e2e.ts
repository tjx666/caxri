import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { createShellSession, launchCaxri, pageRequest } from './helpers.ts';

async function replaceMonacoText(
    app: Awaited<ReturnType<typeof launchCaxri>>['app'],
    page: Page,
    editor: Locator,
    source: string,
): Promise<void> {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), source);
    await editor.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Meta+V');
}

test('Settings keeps actions visible and provides highlighted editors and live Theme preview', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    const pageErrors: string[] = [];
    running.page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Open settings.jsonc Source' }).click();
        const settingsEditor = dialog.getByLabel('settings.jsonc source');
        await expect(settingsEditor.locator('.view-lines')).toContainText('terminal.fontSize');

        const tokenColors = await settingsEditor
            .locator('.view-lines span')
            .evaluateAll((spans) => [
                ...new Set(spans.map((span) => getComputedStyle(span).color)),
            ]);
        expect(tokenColors.length).toBeGreaterThan(1);
        await dialog.getByRole('button', { name: 'Back to Settings UI' }).click();
        await expect(dialog.locator('[data-slot="input"]')).toHaveCount(6);
        await expect(dialog.locator('[data-slot="textarea"]')).toHaveCount(2);
        const defaultAgent = dialog.locator('[data-slot="select-trigger"]');
        await expect(defaultAgent).toContainText('Ask each time');
        await expect(defaultAgent.locator('[data-agent-icon="unknown"]')).toBeVisible();
        await defaultAgent.click();
        for (const [name, icon] of [
            ['Claude Code', 'claude'],
            ['Codex', 'codex'],
            ['Shell', 'shell'],
        ] as const) {
            await expect(
                running.page
                    .getByRole('option', { name, exact: true })
                    .locator(`[data-agent-icon="${icon}"]`),
            ).toBeVisible();
        }
        await running.page.keyboard.press('Escape');
        await expect(dialog.getByLabel('Claude Code executable')).toHaveValue('claude');
        await expect(dialog.getByLabel('Codex executable')).toHaveValue('codex');
        await expect(dialog.getByLabel('New Terminal working directory')).toHaveValue('');
        await expect(dialog.getByLabel('Claude Code initial arguments')).toBeVisible();
        for (const provider of ['claude', 'codex']) {
            await expect(
                dialog.locator(
                    `[data-agent-provider="${provider}"] [data-agent-icon="${provider}"]`,
                ),
            ).toBeVisible();
        }
        await expect(dialog.locator('input[type="number"]').first()).toHaveCSS(
            'appearance',
            'none',
        );
        const workingDirectoryWidth = await dialog
            .getByLabel('New Terminal working directory')
            .evaluate((element) => element.getBoundingClientRect().width);
        const scalarWidth = await dialog
            .getByLabel('Terminal font size')
            .evaluate((element) => element.getBoundingClientRect().width);
        expect(workingDirectoryWidth).toBeGreaterThan(scalarWidth + 100);

        await dialog.getByLabel('Terminal font size').fill('14');
        await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(14);

        const actions = dialog.locator('.dialog-actions');
        const dialogBox = await dialog.boundingBox();
        const actionsBox = await actions.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(
            dialogBox!.y + dialogBox!.height + 1,
        );

        await dialog.getByRole('tab', { name: 'Theme', exact: true }).click();
        const preview = dialog.getByLabel('Theme preview');
        await expect(preview).toBeVisible();
        const backgroundInput = dialog
            .locator('.theme-editor fieldset')
            .nth(1)
            .locator('label')
            .filter({ hasText: /^background/ })
            .locator('input[type="color"]');
        await backgroundInput.fill('#101820');
        await expect
            .poll(() =>
                preview.evaluate((element) =>
                    element.style.getPropertyValue('--preview-background'),
                ),
            )
            .toBe('#101820');

        await dialog.locator('.structured-editor').evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
        expect(pageErrors).toEqual([]);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Settings source mode preserves drafts and blocks stale UI for invalid source', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-source-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const initial = await pageRequest<{ source: string }>(running.page, 'settings.get');
        const legalSource = initial.source
            .replace(/"terminal\.fontSize":\s*\d+/, '"terminal.fontSize": 17')
            .replace(/\n}\s*$/, '\n  // keep-source-comment\n}\n');

        await running.page.keyboard.press('Meta+,');
        let dialog = running.page.getByRole('dialog');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Open Config File' })).toBeVisible();

        await dialog.getByRole('button', { name: 'Open settings.jsonc Source' }).click();
        let sourceEditor = dialog.getByLabel('settings.jsonc source');
        await replaceMonacoText(running.app, running.page, sourceEditor, legalSource);
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(sourceEditor.locator('.view-lines')).toContainText('keep-source-comment');
        await dialog.getByRole('button', { name: 'Back to Settings UI' }).click();
        await expect(dialog.getByLabel('Terminal font size')).toHaveValue('17');
        await expect(
            dialog.getByRole('tab', { name: 'Settings', exact: true }).locator('[data-dirty=true]'),
        ).toBeVisible();

        await dialog.getByRole('button', { name: 'Open settings.jsonc Source' }).click();
        sourceEditor = dialog.getByLabel('settings.jsonc source');
        await replaceMonacoText(
            running.app,
            running.page,
            sourceEditor,
            '{\n  "terminal.fontSize": nope\n}',
        );
        await expect(dialog.getByRole('alert')).toContainText(/settings\.jsonc: .*line 2/);
        await dialog.getByRole('button', { name: 'Back to Settings UI' }).click();
        await expect(sourceEditor).toBeVisible();
        await expect(dialog.getByLabel('Terminal font size')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();

        await replaceMonacoText(running.app, running.page, sourceEditor, legalSource);
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await dialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        await expect(dialog.getByLabel('keybindings.jsonc source')).toBeVisible();
        await dialog.getByRole('tab', { name: 'Theme', exact: true }).click();
        await expect(dialog.getByLabel('theme.json source')).toBeVisible();
        await dialog.getByRole('tab', { name: 'Settings', exact: true }).click();
        await expect(
            dialog.getByLabel('settings.jsonc source').locator('.view-lines'),
        ).toContainText('keep-source-comment');

        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+,');
        dialog = running.page.getByRole('dialog');
        await expect(dialog.getByLabel('Terminal font size')).toHaveValue('17');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Settings JSON');
        await palette.getByRole('option').filter({ hasText: 'Open Settings (JSON)' }).click();
        dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(dialog.getByLabel('settings.jsonc source')).toBeVisible();

        await dialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        const keybindingsEditor = dialog.getByLabel('keybindings.jsonc source');
        await replaceMonacoText(running.app, running.page, keybindingsEditor, '[ invalid');
        await expect(dialog.getByRole('alert')).toContainText('keybindings.jsonc');
        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+Shift+P');
        const blockedPalette = running.page.getByRole('dialog');
        await blockedPalette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Settings JSON');
        await blockedPalette
            .getByRole('option')
            .filter({ hasText: 'Open Settings (JSON)' })
            .click();
        dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Keybindings', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(dialog.getByLabel('keybindings.jsonc source')).toBeVisible();
        await expect(dialog.getByRole('alert')).toContainText('keybindings.jsonc');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Settings shortcut opens while Terminal input has focus', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-shortcut-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createShellSession(running.page);
        const terminalInput = running.page.locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await expect(terminalInput).toBeFocused();

        await running.page.keyboard.press('Meta+,');

        await expect(running.page.getByRole('dialog')).toBeVisible();
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('application menu registers the native macOS Command+H Hide command', async () => {
    test.skip(process.platform !== 'darwin', 'macOS application shortcut');
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-hide-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const hideItem = await running.app.evaluate(({ Menu }) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById('app.hide');
            return item ? { accelerator: item.accelerator, role: item.role } : undefined;
        });
        expect(hideItem).toEqual({ accelerator: 'Command+H', role: 'hide' });
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

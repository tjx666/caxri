import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '..');

async function launch(
    userData: string,
    root: string,
): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await electron.launch({
        args: ['.', '--disable-gpu'],
        cwd: projectRoot,
        env: {
            ...process.env,
            CAXRI_E2E: '1',
            CAXRI_USER_DATA_DIR: userData,
            CAXRI_TEST_ROOT_PATH: root,
        },
    });
    const page = await app.firstWindow();
    await expect(page.getByText('Runtime ready')).toBeVisible();
    return { app, page };
}

test('Settings keeps actions visible and provides highlighted editors and live Theme preview', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launch(userData, root);
    const pageErrors: string[] = [];
    running.page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
        await running.page.getByRole('button', { name: 'Settings', exact: true }).click();
        const dialog = running.page.getByRole('dialog');
        const settingsEditor = dialog.getByLabel('settings.jsonc source');
        await expect(settingsEditor.locator('.view-lines')).toContainText('terminal.fontSize');

        const tokenColors = await settingsEditor
            .locator('.view-lines span')
            .evaluateAll((spans) => [
                ...new Set(spans.map((span) => getComputedStyle(span).color)),
            ]);
        expect(tokenColors.length).toBeGreaterThan(1);
        await expect(dialog.locator('[data-slot="input"]')).toHaveCount(3);
        await expect(dialog.locator('[data-slot="select-trigger"]')).toContainText(
            'Ask when creating a Session',
        );

        const actions = dialog.locator('.dialog-actions');
        const dialogBox = await dialog.boundingBox();
        const actionsBox = await actions.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(
            dialogBox!.y + dialogBox!.height + 1,
        );

        await dialog.getByRole('button', { name: 'Theme', exact: true }).click();
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

test('application menu registers the native macOS Command+H Hide command', async () => {
    test.skip(process.platform !== 'darwin', 'macOS application shortcut');
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-hide-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launch(userData, root);
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

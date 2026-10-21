import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { e2eSettingsPath } from './support/e2e-profile.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri } from './support/helpers.ts';

const ORIGINAL = 'export const greeting = "hello";\n';

/**
 * E2E profiles opt out of auto save by default (see `e2e-profile.ts`); this spec restores the product default before
 * launch so it exercises what a user gets out of the box.
 */
test('the Editor saves a changed file when focus leaves it, and when its dirty tab closes', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-auto-save-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const filePath = join(root, 'greeting.ts');
    await mkdir(root, { recursive: true });
    await writeFile(filePath, ORIGINAL, 'utf8');
    await mkdir(join(userData, 'config'), { recursive: true });
    await writeFile(
        e2eSettingsPath(userData),
        `${JSON.stringify({ 'files.autoSave': 'onFocusChange' }, null, 2)}\n`,
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const fileItem = running.page.getByRole('treeitem', { name: 'greeting.ts', exact: true });
        await fileItem.dblclick();
        const tab = running.page.locator('.work-tab', { hasText: 'greeting.ts' });
        await expect(tab).toBeVisible();
        const editor = running.page.locator('.monaco-editor');

        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+ArrowDown');
        await running.page.keyboard.type('// saved on blur\n');
        await expect(tab).toContainText('●');
        expect(await readFile(filePath, 'utf8')).toBe(ORIGINAL);

        await fileItem.click();
        await expect.poll(() => readFile(filePath, 'utf8')).toContain('// saved on blur');
        await expect(tab).not.toContainText('●');
        await running.page.screenshot({
            path: test.info().outputPath('editor-auto-save-on-blur.png'),
            mask: [running.page.locator('.terminal-surface')],
        });

        await running.app.evaluate(({ dialog }) => {
            Reflect.set(globalThis, '__caxriE2EAutoSaveDialogs', 0);
            dialog.showMessageBox = () => {
                const count = Reflect.get(globalThis, '__caxriE2EAutoSaveDialogs') as number;
                Reflect.set(globalThis, '__caxriE2EAutoSaveDialogs', count + 1);
                return Promise.resolve({ response: 2, checkboxChecked: false });
            };
        });
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+ArrowDown');
        await running.page.keyboard.type('// saved on close\n');
        await expect(tab).toContainText('●');
        await running.page.keyboard.press('Meta+w');

        await expect(tab).toHaveCount(0);
        await expect.poll(() => readFile(filePath, 'utf8')).toContain('// saved on close');
        expect(
            await running.app.evaluate(
                () => Reflect.get(globalThis, '__caxriE2EAutoSaveDialogs') as number,
            ),
        ).toBe(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

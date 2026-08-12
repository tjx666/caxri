import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from './fixtures.ts';

import { createProjectSession, launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('editor Find controls remain stable and close on the first click', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-find-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(join(root, 'searchable.ts'), 'const needle = true;\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        await running.page.getByRole('button', { name: 'searchable.ts', exact: true }).click();
        const editor = running.page.locator('.monaco-editor').first();
        await expect(editor).toBeVisible();

        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+f');
        const findWidget = editor.locator('.find-widget');
        await expect(findWidget).toBeVisible();
        await findWidget.getByRole('textbox', { name: 'Find' }).fill('needle');
        await expect(findWidget).toContainText('1 of 1');

        const matchCase = findWidget.getByRole('checkbox', { name: /Match Case/ });
        await matchCase.click();
        await expect(matchCase).toBeChecked();
        await matchCase.click();
        await expect(matchCase).not.toBeChecked();

        const closeButton = findWidget.getByRole('button', { name: /^Close \(Escape\)$/ });
        await expect(closeButton).toBeVisible();
        const closeBox = await closeButton.boundingBox();
        expect(closeBox?.width).toBeGreaterThanOrEqual(24);
        expect(closeBox?.height).toBeGreaterThanOrEqual(24);
        expect(
            await findWidget.evaluate((element) => getComputedStyle(element).transitionDuration),
        ).toBe('0s');

        await closeButton.hover();
        await running.page.waitForTimeout(300);
        expect(
            await closeButton.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return document
                    .elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.top + bounds.height / 2,
                    )
                    ?.closest('[aria-label]')
                    ?.getAttribute('aria-label');
            }),
        ).toBe('Close (Escape)');
        await closeButton.click();
        await expect(findWidget).toHaveAttribute('aria-hidden', 'true');

        await running.page.keyboard.press('Meta+f');
        await expect(findWidget).toHaveAttribute('aria-hidden', 'false');
        await running.page.keyboard.press('Escape');
        await expect(findWidget).toHaveAttribute('aria-hidden', 'true');
        await expect(editor).toHaveClass(/focused/);

        await running.page.keyboard.press('Meta+f');
        await expect(findWidget).toHaveAttribute('aria-hidden', 'false');
        await running.page.keyboard.press('Meta+]');
        await running.page.setViewportSize({ width: 1_000, height: 700 });
        await findWidget.getByRole('button', { name: /^Close \(Escape\)$/ }).click();
        await expect(findWidget).toHaveAttribute('aria-hidden', 'true');
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

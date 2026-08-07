import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { createProjectSession, launchCaxri } from './helpers.ts';

const execFileAsync = promisify(execFile);

test('editor previews pin and expose the standard close actions', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await Promise.all(
        ['a.js', 'b.js', 'c.js', 'd.js'].map((name) =>
            writeFile(join(root, name), `export const ${name[0]} = true;\n`, 'utf8'),
        ),
    );
    await writeFile(join(root, '.env'), '# Caxri\nCAXRI_TOKEN="enabled"\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const editorTabs = running.page.locator('.work-tab[data-preview]');
        await running.page.getByRole('button', { name: 'a.js', exact: true }).click();
        await expect(editorTabs).toHaveCount(1);
        await expect(editorTabs).toContainText('a.js');

        await running.page.getByRole('button', { name: 'b.js', exact: true }).click();
        await expect(running.page.locator('.work-tab', { hasText: 'a.js' })).toHaveCount(0);
        const bTab = running.page.locator('.work-tab', { hasText: 'b.js' });
        await expect(bTab.locator('[data-file-icon="javascript"]')).toBeVisible();
        await expect(bTab).toHaveAttribute('data-preview', 'true');
        await bTab.getByRole('tab').dblclick();
        await expect(bTab).not.toHaveAttribute('data-preview');

        /** Reproduces the custom tokenizer race seen on loaded GitHub-hosted runners. */
        const cdp = await running.page.context().newCDPSession(running.page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
        await running.page.getByRole('button', { name: '.env', exact: true }).click();
        const environmentLine = running.page
            .locator('.view-line')
            .filter({ hasText: 'CAXRI_TOKEN' });
        await expect
            .poll(() =>
                environmentLine.locator('span span').evaluateAll((tokens) => {
                    const colors = new Set(tokens.map((token) => getComputedStyle(token).color));
                    return tokens.length > 1 && colors.size > 1;
                }),
            )
            .toBe(true);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await cdp.detach();

        await running.page.getByRole('button', { name: 'c.js', exact: true }).click();
        const cTab = running.page.locator('.work-tab', { hasText: 'c.js' });
        await expect(cTab).toHaveAttribute('data-preview', 'true');
        await running.page.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.type(' ');
        await expect(cTab).not.toHaveAttribute('data-preview');

        await running.page.getByRole('button', { name: 'd.js', exact: true }).dblclick();
        const dTab = running.page.locator('.work-tab', { hasText: 'd.js' });
        await expect(dTab).not.toHaveAttribute('data-preview');

        expect(
            await running.page
                .locator('.work-tabs')
                .evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').height),
        ).toBe('3px');

        await cTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Close to the Right' }).click();
        await expect(dTab).toHaveCount(0);
        await expect(bTab).toBeVisible();
        await expect(cTab).toBeVisible();

        await running.page.getByRole('button', { name: 'a.js', exact: true }).dblclick();
        await cTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Close Others' }).click();
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(1);
        await expect(cTab).toBeVisible();

        await cTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Close All' }).click();
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
    } finally {
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
